---
name: isolated-json-request
description: Run a one-off isolated JSON request through the signed-in Codex CLI when an external library or service is unnecessary.
---

# Isolated JSON request

Use this skill for a manual, one-off structured request. Do not use it to expose an HTTP endpoint or integrate another application; use `subscription-runner` for those cases.

1. Require a JSON Schema for the final response. If none is supplied, ask for one or use a plain-text response instead.
2. Create a new empty temporary working directory for the request. Do not use the caller's project directory or attach project files.
3. Run a fresh Codex CLI invocation with `--ephemeral`, `--ignore-user-config`, `--skip-git-repo-check`, `--sandbox read-only`, `--cd <temporary-directory>`, `--json`, and `--output-schema <schema-file>`.
4. Pass only the user's task and JSON input. Parse the final `agent_message` JSONL event; do not return Codex internal events.
5. Remove the temporary directory after the process exits, including failures.

This reduces project context but cannot remove Codex built-in instructions, provider safety policies, authentication, or service telemetry. A global `~/.codex/AGENTS.md`, if present, may still apply.
