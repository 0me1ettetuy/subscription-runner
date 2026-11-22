import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Batcher, RequestError, Runner } from "../src/runner.js";

test("Runner rejects filesystem-affecting request fields", async () => {
  const runner = new Runner({ codex: "unused" });
  assert.throws(() => runner.submit({ prompt: "hello", cwd: "/project" }), RequestError);
});

test("Batcher combines compatible jobs and returns each item result", async () => {
  const calls = [];
  const batcher = new Batcher({
    runner: {
      async submitWithUsage(job) {
        calls.push(job);
        return { result: { results: job.input.map(({ id, input }) => ({ id, result: { value: input.value } })) }, usage: null };
      }
    },
    maxItems: 2,
    waitMs: 1_000
  });
  const schema = { type: "object", properties: { value: { type: "number" } }, required: ["value"] };
  const [first, second] = await Promise.all([
    batcher.submit({ prompt: "echo", input: { value: 1 }, schema }),
    batcher.submit({ prompt: "echo", input: { value: 2 }, schema })
  ]);

  assert.deepEqual(first, { value: 1 });
  assert.deepEqual(second, { value: 2 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.length, 2);
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
