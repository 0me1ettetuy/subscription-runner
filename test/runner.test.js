import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { BatchRunner, RequestError, Runner, chunkItems } from "../src/runner.js";

test("Runner rejects filesystem-affecting request fields", async () => {
  const runner = new Runner({ codex: "unused" });
  assert.throws(() => runner.submit({ prompt: "hello", cwd: "/project" }), RequestError);
});

test("BatchRunner splits a caller-provided batch and restores input order", async () => {
  const calls = [];
  const batchRunner = new BatchRunner({
    runner: {
      async submitWithUsage(job) {
        calls.push(job);
        return {
          result: { results: job.input.map(({ id, input }) => ({ id, result: { value: input.value } })) },
          usage: { input_tokens: 10, output_tokens: 2 }
        };
      }
    },
    maxItems: 2,
    maxBytes: 1_000
  });
  const schema = { type: "object", properties: { value: { type: "number" } }, required: ["value"] };
  const completed = await batchRunner.submitWithUsage({
    prompt: "echo",
    schema,
    items: [
      { id: "one", input: { value: 1 } },
      { id: "two", input: { value: 2 } },
      { id: "three", input: { value: 3 } }
    ]
  });

  assert.deepEqual(completed.results, [
    { id: "one", result: { value: 1 } },
    { id: "two", result: { value: 2 } },
    { id: "three", result: { value: 3 } }
  ]);
  assert.deepEqual(completed.usage, { input_tokens: 20, output_tokens: 4 });
  assert.equal(completed.batches, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].input.length, 2);
  assert.equal(calls[1].input.length, 1);
});

test("chunkItems splits early when serialized input exceeds the byte limit", () => {
  const batch = {
    prompt: "echo",
    schema: { type: "object" },
    items: [
      { id: "one", input: "a".repeat(40) },
      { id: "two", input: "b".repeat(40) }
    ]
  };
  const chunks = chunkItems(batch, { maxItems: 100, maxBytes: 120 });
  assert.deepEqual(chunks.map((chunk) => chunk.map(({ id }) => id)), [["one"], ["two"]]);
});

test("Runner returns the final structured Codex message", async () => {
  const codex = fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url));
  const runner = new Runner({ codex });
  const result = await runner.submit({
    prompt: "answer",
    schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }
  });
  assert.deepEqual(result, { answer: "ok" });
});

test("Runner exposes Codex token usage when it is reported", async () => {
  const codex = fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url));
  const runner = new Runner({ codex });
  const completed = await runner.submitWithUsage({ prompt: "answer" });
  assert.equal(completed.result, '{"answer":"ok"}');
  assert.deepEqual(completed.usage, { input_tokens: 12, output_tokens: 3 });
});
