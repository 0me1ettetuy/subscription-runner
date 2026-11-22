import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

function assertBatch(batch) {
  assertJob(batch);
  if (!batch.schema) throw new RequestError("schema is required for batch jobs.");
  if (!Array.isArray(batch.items) || !batch.items.length) {
    throw new RequestError("items must be a non-empty array.");
  }
  const ids = new Set();
  for (const item of batch.items) {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.id !== "string" || !("input" in item)) {
      throw new RequestError("Each item must contain a string id and an input value.");
    }
    if (ids.has(item.id)) throw new RequestError(`Duplicate item id: ${item.id}.`);
    ids.add(item.id);
  }
}

function batchSchema(schema) {
  return {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" }, result: schema },
          required: ["id", "result"],
          additionalProperties: false
        }
      }
    },
    required: ["results"],
    additionalProperties: false
  };
}

export function chunkItems(batch, { maxItems, maxBytes }) {
  const fixedBytes = Buffer.byteLength(JSON.stringify({ prompt: batch.prompt, schema: batch.schema }));
  const chunks = [];
  let chunk = [];
  let bytes = fixedBytes;

  for (const item of batch.items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item));
    if (chunk.length && (chunk.length === maxItems || bytes + itemBytes > maxBytes)) {
      chunks.push(chunk);
      chunk = [];
      bytes = fixedBytes;
    }
    if (fixedBytes + itemBytes > maxBytes) {
      throw new RequestError(`Item ${item.id} exceeds the ${maxBytes}-byte chunk limit.`, 413);
    }
    chunk.push(item);
    bytes += itemBytes;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

function addUsage(total, usage) {
  if (!usage) return total;
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === "number") total[key] = (total[key] || 0) + value;
  }
  return total;
}

export class BatchRunner {
  constructor({ runner, maxItems = 1000, maxBytes = 131_072 }) {
    this.runner = runner;
    this.maxItems = maxItems;
    this.maxBytes = maxBytes;
  }

  submit(batch) {
    return this.submitWithUsage(batch).then(({ results }) => results);
  }

  async submitWithUsage(batch) {
    assertBatch(batch);
    const chunks = chunkItems(batch, this);
    const completed = await Promise.all(chunks.map((items) => this.#runChunk(batch, items)));
    const results = new Map();
    const usage = {};

    for (const chunk of completed) {
      addUsage(usage, chunk.usage);
      for (const entry of chunk.result.results) results.set(entry.id, entry.result);
    }

    return {
      results: batch.items.map(({ id }) => {
        if (!results.has(id)) throw new RequestError(`Batch response omitted ${id}.`, 502);
        return { id, result: results.get(id) };
      }),
      usage: Object.keys(usage).length ? usage : null,
      batches: chunks.length
    };
  }

  #runChunk(batch, items) {
    return this.runner.submitWithUsage({
      prompt: `${batch.prompt}\n\nProcess each independent input exactly once. Preserve every id and return one result for each item.`,
      input: items,
      schema: batchSchema(batch.schema)
    });
  }
}

export function readJsonBody(request, maxBytes = 10_000_000) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        reject(new RequestError("Request body exceeds 10 MB.", 413));
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
