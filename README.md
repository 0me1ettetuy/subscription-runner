# subscription-runner

Local JSON jobs for an existing Codex CLI sign-in. It starts each job in a new temporary empty workspace, runs Codex with `--ephemeral` and a read-only sandbox, and removes that workspace when the job ends.

The runner closes each child process's stdin so Codex treats the supplied prompt as the complete request rather than waiting for piped input.

## Install from GitHub

```sh
npm install -g github:YOUR-NAME/subscription-runner
subscription-runner connect
subscription-runner serve
```

`connect` delegates to `codex login`; this package never reads credentials. The server listens only on `127.0.0.1:4312`.

## Batch job format

`POST /jobs` accepts one complete batch. Every item needs a stable string `id` and its JSON `input`.

```json
{
  "prompt": "Extract a name",
  "schema": { "type": "object" },
  "items": [
    { "id": "item-1", "input": { "text": "Ada Lovelace" } }
  ]
}
```

The runner splits the submitted batch only when needed: at 1,000 items or 128 KiB of serialized prompt, schema, and inputs per Codex call. Its response returns ordered `results`, the total number of internal `batches`, and aggregate Codex `usage` from `turn.completed` events.

Project paths, shell commands, and sandbox overrides are rejected to preserve isolated requests.

## Limits

This is not the OpenAI API. Each request uses the current user’s Codex subscription allowance and is subject to its limits. Codex’s built-in instructions and service-side policies cannot be removed.
