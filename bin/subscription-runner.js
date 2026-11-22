#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { Runner, Batcher, readJsonBody } from "../src/runner.js";

const usage = `Usage:
  subscription-runner connect
  subscription-runner status
  subscription-runner serve [--port 4312] [--concurrency 1] [--batch-size 10] [--batch-wait-ms 750] [--timeout-ms 90000]`;

const [command, ...args] = process.argv.slice(2);
const codex = process.env.SUBSCRIPTION_RUNNER_CODEX || "codex";

if (command === "connect" || command === "status") {
  const result = spawnSync(codex, command === "connect" ? ["login"] : ["login", "status"], {
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  process.exit(result.status ?? 1);
}

if (command !== "serve") {
  console.error(usage);
  process.exit(1);
}

const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : Number(args[index + 1]);
};
const port = option("--port", 4312);
const concurrency = option("--concurrency", 1);
const batchSize = option("--batch-size", 10);
const batchWaitMs = option("--batch-wait-ms", 750);
const timeoutMs = option("--timeout-ms", 90_000);

if (![port, concurrency, batchSize, batchWaitMs, timeoutMs].every(Number.isSafeInteger) ||
  port < 1 || port > 65535 || concurrency < 1 || batchSize < 1 || batchWaitMs < 0 || timeoutMs < 1) {
  console.error("Invalid numeric option.");
  process.exit(1);
}

const runner = new Runner({ codex, concurrency, timeoutMs });
const batcher = new Batcher({ runner, maxItems: batchSize, waitMs: batchWaitMs });

const server = createServer(async (request, response) => {
  response.setHeader("content-type", "application/json; charset=utf-8");

  if (request.method === "GET" && request.url === "/health") {
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (request.method !== "POST" || request.url !== "/jobs") {
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  try {
    const job = await readJsonBody(request);
    const completed = job.batch === true ? await batcher.submitWithUsage(job) : await runner.submitWithUsage(job);
    response.end(JSON.stringify({ status: "completed", result: completed.result, usage: completed.usage, batch: completed.batch ?? null }));
  } catch (error) {
    response.statusCode = error.statusCode || 400;
    response.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`subscription-runner listening on http://127.0.0.1:${port}`);
});
