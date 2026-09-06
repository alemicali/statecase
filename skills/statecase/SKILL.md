---
name: statecase
description: Connect, carry, synchronize, hydrate, recover, publish, inspect, or restore portable agent sessions, skills, operational context, work in progress, and arbitrary Drops with the Statecase CLI. Use when an agent must continue work on another machine, attach its harness, inspect sync status, resolve a Statecase conflict, or make context portable. Do not use for ordinary Git operations or generic file copies unrelated to Statecase.
---

# Statecase

Treat `statecase` as the stable automation boundary. Do not inspect its credential files or reproduce secret values in chat, command arguments, logs, or tool output.

## Start every operation

Run:

```bash
statecase --json status
```

Read the JSON and decide whether login, vault enrollment, harness setup, a Drop mapping, or synchronization is missing.

## Safe workflow

1. Use `statecase --json doctor` before a first sync on a machine.
2. If authentication is missing, tell the operator to run `statecase login`. In unattended environments, use an already injected `STATECASE_TOKEN`; never ask for its value.
3. If a vault key is missing, request enrollment through a trusted recovery kit. Never ask the operator to paste recovery material into chat.
4. Configure harness-owned state with `statecase setup --harness codex`, `claude`, or `codex,claude`.
5. Configure arbitrary context with `statecase drop add` on its origin or `statecase drop map` on another machine.
6. Preview a risky transfer with `--dry-run`, then run `statecase --json sync`.
7. Inspect exit codes and JSON. Do not scrape decorative human output.

## Error policy

- Exit `3`: authentication or enrollment is required; ask the operator to complete it outside chat.
- Exit `5`: preserve both sides and report the conflicting paths. Do not overwrite them.
- Exit `6`: stop. Treat this as an integrity or cryptographic failure.
- Exit `7`: keep local work intact and retry later with bounded backoff.
- Any proposed restore or overwrite must be previewed and explicitly approved by the operator.

Statecase synchronization must remain functional without model participation. Do not simulate a daemon by repeatedly polling from the conversation.
