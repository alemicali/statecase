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

Read the JSON fields `accessMode`, `namespaces`, and `expiresAt`. Decide whether full login/vault enrollment, scoped bootstrap, harness setup, a Drop mapping, or synchronization is missing.

## Ephemeral bootstrap

On a trusted full-access device, create a least-privilege grant with `statecase token create --namespace <ids> --actions read,append --ttl <minutes> --output <protected-path>`. Never request or echo the generated file contents. Prefer `read` without `append` when the sandbox does not need to return work.

In a fresh sandbox profile, redeem through an injected `STATECASE_BOOTSTRAP_TOKEN` or `statecase bootstrap --token-file <secret-mount> --non-interactive`. Do not put the token itself in a command argument. Then attach only the authorized workspace IDs, map only the authorized Drop IDs, run `statecase --json pull`, and launch through `statecase run <harness> -- <args>` when supervised synchronization is desired.

A scoped client has no vault root key. Treat an authorization error for an unlisted namespace as an intended boundary, not as a reason to inspect credentials or fall back to raw copy/Git. After successful redemption, tell the operator or deployment system to remove the one-time bootstrap secret. A trusted device can inspect and revoke grants with `statecase token list` and `statecase token revoke <id> --yes`.

## Safe workflow

1. Use `statecase --json doctor` before a first sync on a machine.
2. If authentication is missing, tell the operator to run `statecase login`. In unattended environments, use an already injected `STATECASE_TOKEN`; never ask for its value.
3. If a vault key is missing, request enrollment through a trusted recovery kit. Never ask the operator to paste recovery material into chat.
4. Configure harness-owned state with `statecase setup --harness codex`, `claude`, or `codex,claude`.
5. Configure arbitrary context with `statecase drop add` on its origin or `statecase drop map` on another machine.
6. Preview a risky transfer with `--dry-run`, then run `statecase --json sync`.
7. Inspect exit codes and JSON. Do not scrape decorative human output.

## Resume a session

Before resuming on a different machine, run `statecase --json workspace dependencies` and select the intended `sessionCapsuleId`. Hydrate that immutable closure with:

```bash
statecase --json workspace hydrate --session <sessionCapsuleId> --mode strict --dry-run
statecase --json workspace hydrate --session <sessionCapsuleId> --mode strict
```

Use `strict` for unattended work. In an interactive workflow, `warn` may materialize the available closure and exits `8` when dependencies remain unresolved; explain those paths before launching the harness. Use `best-effort` only when the operator explicitly accepts an incomplete context. An external dependency must be mapped as a Drop and checkpointed; never copy it ad hoc.

## Error policy

- Exit `3`: authentication or enrollment is required; ask the operator to complete it outside chat.
- Exit `5`: preserve both sides and report the conflicting paths. Do not overwrite them.
- Exit `6`: stop. Treat this as an integrity or cryptographic failure.
- Exit `7`: keep local work intact and retry later with bounded backoff.
- Exit `8`: the requested work completed only partially or with unresolved context; report the warnings and do not claim an exact resume.
- Any proposed restore or overwrite must be previewed and explicitly approved by the operator.

Statecase synchronization must remain functional without model participation. Do not simulate a daemon by repeatedly polling from the conversation.
