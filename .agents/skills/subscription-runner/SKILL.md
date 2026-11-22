---
name: subscription-runner
description: Use the local subscription-runner service for isolated, schema-constrained Codex JSON jobs from a script or application.
---

# subscription-runner

Use this skill when a local `subscription-runner` service is already installed and the request should be made through its JSON interface.

1. Verify the local service with `GET http://127.0.0.1:4312/health`. If it is unavailable, tell the user to run `subscription-runner serve`.
2. Submit only `prompt`, optional `input`, and optional `schema` to `POST /jobs`. Do not send `cwd`, commands, credentials, project files, or sandbox settings: the runner deliberately rejects them.
3. Use a JSON Schema whenever downstream code consumes the result. Treat non-2xx replies as failed jobs.
4. Add `batch: true` only for independent jobs with the same prompt and schema. The runner groups them briefly, then returns each result separately.
5. Do not report the runner as an OpenAI API replacement. It uses Codex CLI subscription limits and creates fresh ephemeral Codex jobs.
