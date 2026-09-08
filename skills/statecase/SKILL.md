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

For native memory selection, relocation or `MEMORY_REFERENCE_UNRESOLVED`, read [memory collections](references/memory.md).
Memory is separate from global instructions and Drops; ordinary harness setup
does not select it or enable native recall.

## Ephemeral bootstrap

On a trusted full-access device, create a least-privilege grant with `statecase token create --namespace <ids> --actions read,append --ttl <minutes> --output <protected-path>`. Never request or echo the generated file contents. Prefer `read` without `append` when the sandbox does not need to return work.

In a fresh sandbox profile, redeem through an injected `STATECASE_BOOTSTRAP_TOKEN` or `statecase bootstrap --token-file <secret-mount> --non-interactive`. Do not put the token itself in a command argument. Then attach only the authorized workspace IDs, map only the authorized Drop IDs, run `statecase --json pull`, and launch through `statecase run <harness> -- <args>` when supervised synchronization is desired.

For a fresh Git checkout that may be shallow, attach the workspace with `--git-fetch auto` only when the operator or deployment policy has authorized device-local Git network access. Statecase uses that checkout's existing `origin` and system credential helper; it never supplies or synchronizes Git credentials. Use `--git-fetch never` when provisioning guarantees the commit is already local.

A scoped client has no vault root key. Treat an authorization error for an unlisted namespace as an intended boundary, not as a reason to inspect credentials or fall back to raw copy/Git. After successful redemption, tell the operator or deployment system to remove the one-time bootstrap secret. A trusted device can inspect and revoke grants with `statecase token list` and `statecase token revoke <id> --yes`.

## Safe workflow

1. Use `statecase --json doctor` before a first sync on a machine.
2. If authentication is missing, tell the operator to run `statecase login`. In unattended environments, use an already injected `STATECASE_TOKEN`; never ask for its value.
3. If a vault key is missing, request enrollment through a trusted recovery kit. Never ask the operator to paste recovery material into chat.
4. Configure harness-owned state with `statecase setup --harness codex`, `claude`, or `codex,claude`.
5. If an attached checkout changes local path, use `statecase workspace move <id> <path>` and pull before resume. Use `workspace detach <id>` to remove only the device-local mapping; it must not be described as deleting files or cloud state.
6. Use `statecase --json workspace capsule <id>` to preview aggregate local Git overlay metadata without syncing. Do not claim it prints content or inspects remote Session Capsules; use `workspace dependencies` for the latter.
7. Configure arbitrary context with `statecase drop add` on its origin or `statecase drop map` on another machine. Use `statecase --json drop status [id]` to compare root availability and applied/remote revisions; `applied` is not a local dirty-file scan.
8. Use `statecase drop remove <id>` only to forget that device's mapping. Never describe it as deleting local files or the encrypted remote namespace.
9. Preview a risky transfer with `--dry-run`, then run `statecase --json sync`.
10. Inspect exit codes and JSON. Do not scrape decorative human output.

On a full-key device, Statecase may merge concurrent complete-record appends to
the same portable Codex or Claude session. If a push succeeds but status still
shows the harness namespace behind, run `statecase --json pull` before resume;
this is intentional because the merged remote stream contains records from the
other branch. A scoped capability never performs this trusted same-path merge.

## Lost device and key rotation

Use `statecase --json device list` to identify the exact installation. Revoking
a device and rotating keys are separate destructive/security mutations: do not
run either without explicit operator authorization. After
`statecase --json device revoke <id> --yes` reports
`keyRotationRequired: true`, select each affected vault and run:

```bash
statecase --json vault key rotate --recovery-file <new-protected-path> --yes
statecase --json sync
```

The recovery path must not already exist or lie inside a synchronized root.
Supply `STATECASE_RECOVERY_PASSPHRASE` through the operator or secret manager;
never request, print, or inspect it. Rotation creates a new root, excludes the
revoked device, invalidates existing scoped capabilities, and returns
`rekeyPending` until configured namespaces are published under the new epoch.
If an active device predates exchange keys, ask the operator to log in again on
that device or explicitly revoke it; never omit it silently.

When exit `7` says the outcome is unknown, preserve the reported recovery kit
and do not retry rotation. Restore connectivity and run `statecase --json sync`;
the CLI will ingest the committed device envelope if the rotation succeeded.
Only retire the old recovery kit after an active peer has synchronized and a
clean replacement-device recovery has succeeded with the new kit. A stale kit
fails with integrity exit `6`; do not work around it by copying raw keys.

Explain the boundary accurately: revocation plus rotation protects content
first written under the new epoch, but cannot erase plaintext, old keys, or
historical ciphertext already copied by the lost device.

## Resume a session

Before resuming on a different machine, run `statecase --json workspace dependencies` and select the intended `sessionCapsuleId`. Hydrate that immutable closure with:

```bash
statecase --json workspace hydrate --session <sessionCapsuleId> --mode strict --dry-run
statecase --json workspace hydrate --session <sessionCapsuleId> --mode strict
```

Use `strict` for unattended work. In an interactive workflow, `warn` may materialize the available closure and exits `8` when dependencies remain unresolved; explain those paths before launching the harness. Use `best-effort` only when the operator explicitly accepts an incomplete context. An external dependency must be mapped as a Drop and checkpointed; never copy it ad hoc.

Treat the capsule as the authority even when its harness, workspace, Drops and memory collections pin different revision IDs. The CLI authenticates and atomically composes those historical namespace states; never replace a pinned revision with the current head. Bind required memory IDs locally before strict hydration; do not substitute another project's memory.

## Restore safely

Prefer staging inspection with `statecase --json restore --revision <id> --mapping <id> --target <staging-dir> --dry-run`. Never use a configured live mapping path as a staging target.

For a two-way Drop, Codex/Claude mapping, or `git-overlay` workspace, in-place restore is allowed only on a full-key device and only after explicit operator approval. Run `statecase --json restore --revision <id> --mapping <id> --in-place --dry-run`, report creates/replaces/deletes, and ask the operator to stop the Statecase daemon and every process using the affected harness or workspace. After approval, run the same command with `--yes` instead of `--dry-run`. Do not launch or mutate the affected harness/workspace from the same agent turn while restoring it. Metadata-only workspaces have no Git state to restore.

Preserve the returned `protectedSnapshotId` and `emergencySnapshotPath`. Explain that the historical state was published as a new forward revision, not as a remote-head rewind. A workspace recovery snapshot includes HEAD/ref identity, the raw index, and affected worktree paths; initialized submodules fail closed. If the operator explicitly requests the pre-restore local state, keep daemon/harness/workspace writers stopped and run `statecase --json emergency rollback <emergencySnapshotPath> --yes`; this rollback works without cloud access. Never edit or relocate the emergency snapshot before verification.

## Retention maintenance

Use `statecase --json retention plan` to inspect encrypted object and byte counts without mutation. Run `statecase --json retention collect --yes` only after explicit operator approval; normal installations already receive the same retention policy from the daily cloud schedule. Never remove R2 objects directly. Treat `GC_BUSY` as bounded contention and retry after the reported lease interval.

## Error policy

- Exit `3`: authentication or enrollment is required; ask the operator to complete it outside chat.
- Exit `5`: preserve both sides and report the conflicting paths. A rewritten
  session prefix or incompatible event order is not a safe append; do not force
  resolution automatically or concatenate the files.
- If exit `5` reports that local configuration changed, reread status and the
  relevant mappings before retrying the intended configuration change. Never
  replace `config.json` from an old copy; another process may have added memory
  bindings or applied revisions. Do not blindly retry an ambiguous remote mutation.
- `BASELINE_UNAVAILABLE` with exit `5`: if policy is `ask`, request approval to fetch with system Git or have the operator provision the commit. After approval, reattach the same ID/path with `--git-fetch auto` and retry. Never ask for Git credentials in chat and never change a `never` policy without explicit direction.
- `GIT_LFS_CONTENT_UNAVAILABLE` with exit `5`: report the logical paths and reason. If the workspace policy is `ask`, request approval to reattach it with `--git-fetch auto`; Statecase will use only device-local Git LFS, its cache, and the existing origin. For `binary-missing`, ask the operator to install Git LFS; for `download-failed`, ask them to verify device-local credentials/network; for `integrity`, stop and preserve the rollback. Never request credentials, copy LFS storage, or silently switch to metadata-only mode.
- Exit `6`: stop. This includes integrity, cryptographic and client/service
  compatibility failures. If the diagnostic requires compatible releases, ask
  the operator to align the CLI and service versions before retrying. Do not
  forge capability headers, downgrade a profile, remove native files or bypass
  Statecase with raw copying. A compatibility refusal before bootstrap redemption
  does not consume the one-time grant; preserve its secret mount for the authorized
  retry. An ambiguous network failure is not proof that redemption did not occur.
- Exit `7`: keep local work intact and retry later with bounded backoff.
- Exit `8`: the requested work completed only partially or with unresolved context; report the warnings and do not claim an exact resume.
- Any proposed restore or overwrite must be previewed and explicitly approved by the operator.

Statecase synchronization must remain functional without model participation. Do not simulate a daemon by repeatedly polling from the conversation.
