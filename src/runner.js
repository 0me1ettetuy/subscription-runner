import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class RequestError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function assertJob(job) {
  if (!job || typeof job !== "object" || Array.isArray(job)) {
    throw new RequestError("Request body must be a JSON object.");
  }
  if (typeof job.prompt !== "string" || !job.prompt.trim()) {
    throw new RequestError("prompt must be a non-empty string.");
  }
  if ("cwd" in job || "sandbox" in job || "command" in job) {
    throw new RequestError("cwd, sandbox, and command are not accepted by the isolated runner.");
  }
  if (job.schema !== undefined && (!job.schema || typeof job.schema !== "object" || Array.isArray(job.schema))) {
    throw new RequestError("schema must be a JSON Schema object.");
  }
}

function makePrompt({ prompt, input }) {
  return input === undefined ? prompt : `${prompt}\n\nInput JSON:\n${JSON.stringify(input)}`;
}

function finalMessage(event) {
  if (event.type !== "item.completed" || event.item?.type !== "agent_message") return undefined;
  return typeof event.item.text === "string" ? event.item.text : undefined;
}

export class Runner {
  constructor({ codex = "codex", concurrency = 1, timeoutMs = 90_000 }) {
    this.codex = codex;
    this.concurrency = concurrency;
    this.timeoutMs = timeoutMs;
    this.active = 0;
    this.queue = [];
  }

  submit(job) {
    return this.submitWithUsage(job).then(({ result }) => result);
  }

  submitWithUsage(job) {
    assertJob(job);
    return new Promise((resolve, reject) => {
      this.queue.push({ job, resolve, reject });
      this.#drain();
    });
  }

  #drain() {
    while (this.active < this.concurrency && this.queue.length) {
      const next = this.queue.shift();
      this.active += 1;
      this.#run(next.job).then(next.resolve, next.reject).finally(() => {
        this.active -= 1;
        this.#drain();
      });
    }
  }

  async #run(job) {
    const workspace = await mkdtemp(join(tmpdir(), "subscription-runner-"));
    try {
      const args = [
        "exec", "--json", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check",
        "--sandbox", "read-only", "--cd", workspace
      ];
      if (job.schema) {
        const schemaPath = join(workspace, "output-schema.json");
        await writeFile(schemaPath, JSON.stringify(job.schema));
        args.push("--output-schema", schemaPath);
      }
      args.push(makePrompt(job));

      const { message, stderr, exitCode, usage } = await runProcess(this.codex, args, this.timeoutMs);
      if (exitCode !== 0) throw new RequestError(stderr || `Codex exited with code ${exitCode}.`, 502);
      if (!message) throw new RequestError("Codex returned no final message.", 502);
      if (!job.schema) return { result: message, usage };
      try {
        return { result: JSON.parse(message), usage };
      } catch {
        throw new RequestError("Codex final message was not valid JSON.", 502);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}

function runProcess(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let message;
    let usage;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new RequestError(`Could not start Codex: ${error.message}`, 502));
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new RequestError(`Codex exceeded the ${timeoutMs} ms job timeout.`, 504));
        return;
      }
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          message = finalMessage(event) || message;
          if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") usage = event.usage;
        } catch {
          // Codex --json output is JSONL; malformed lines are ignored and fail below if no final message arrives.
        }
      }
      resolve({ message, stderr: stderr.trim(), exitCode, usage: usage ?? null });
    });
  });
}

export class Batcher {
  constructor({ runner, maxItems = 10, waitMs = 750 }) {
    this.runner = runner;
    this.maxItems = maxItems;
    this.waitMs = waitMs;
    this.groups = new Map();
  }

  submit(job) {
    return this.submitWithUsage(job).then(({ result }) => result);
  }

  submitWithUsage(job) {
    assertJob(job);
    if (!job.schema) throw new RequestError("batch jobs require a schema.");
    const key = createHash("sha256").update(JSON.stringify([job.prompt, job.schema])).digest("hex");
    let group = this.groups.get(key);
    if (!group) {
      group = { job, entries: [], timer: undefined };
      this.groups.set(key, group);
      group.timer = setTimeout(() => this.#flush(key, group), this.waitMs);
    }

    return new Promise((resolve, reject) => {
      group.entries.push({ id: randomUUID(), input: job.input, resolve, reject });
      if (group.entries.length >= this.maxItems) this.#flush(key, group);
    });
  }

  async #flush(key, group) {
    if (this.groups.get(key) !== group || group.flushing) return;
    group.flushing = true;
    clearTimeout(group.timer);
    this.groups.delete(key);

    const schema = {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" }, result: group.job.schema },
            required: ["id", "result"],
            additionalProperties: false
          }
        }
      },
      required: ["results"],
      additionalProperties: false
    };
    const prompt = `${group.job.prompt}\n\nProcess each independent input exactly once. Preserve every id and return one result for each item.`;
    const input = group.entries.map(({ id, input: value }) => ({ id, input: value }));

    try {
      const completed = await this.runner.submitWithUsage({ prompt, input, schema });
      const results = new Map(completed.result.results.map((entry) => [entry.id, entry.result]));
      for (const entry of group.entries) {
        if (!results.has(entry.id)) entry.reject(new RequestError(`Batch response omitted ${entry.id}.`, 502));
        else entry.resolve({ result: results.get(entry.id), usage: completed.usage, batch: { size: group.entries.length } });
      }
    } catch (error) {
      for (const entry of group.entries) entry.reject(error);
    }
  }
}

export function readJsonBody(request, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        reject(new RequestError("Request body exceeds 1 MB.", 413));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new RequestError("Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}
