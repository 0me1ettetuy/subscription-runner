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

## Job format

`POST /jobs` accepts `prompt`, optional `input`, and optional JSON `schema`. Project paths, shell commands, and sandbox overrides are rejected to preserve isolated requests.

Job responses include Codex's reported `usage` from its `turn.completed` event when available. Batch jobs return the shared aggregate usage and batch size; that usage cannot be attributed accurately to one original item.

Add `"batch": true` to compatible schema jobs. The runner groups jobs with the same prompt and schema for up to 750 ms (or until ten arrive), sends one Codex request, then resolves every original job separately.

## Limits

This is not the OpenAI API. Each request uses the current user’s Codex subscription allowance and is subject to its limits. Codex’s built-in instructions and service-side policies cannot be removed.
