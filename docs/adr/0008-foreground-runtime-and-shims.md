# ADR 0008: Foreground runtime and transparent shims

Status: accepted
Date: 2026-09-06
Owners: Statecase maintainers
Test IDs: RT-001 through RT-006, RT-011, RT-012, RT-013, RT-014, BK-008, BK-009

## Context

Manual synchronization does not satisfy harness transparency or protect work
when an interactive process exits while the network is unavailable. Statecase
must wrap the original Codex and Claude executables without patching them,
changing their arguments, taking ownership of their native state, or turning
network availability into a launch dependency.

## Decision

`statecase run <harness> -- <args>` is the canonical foreground supervisor. It
performs a bounded preflight pull, spawns the recorded real executable with
inherited standard streams and terminal, forwards process signals, publishes
at a bounded interval, requests a bounded final flush, and returns the child
exit status. Synchronization failure queues a redacted operation in the local
SQLite journal and never prevents normal offline harness use.

Transparent POSIX shims are small Statecase-owned shell files that invoke the
foreground supervisor with the exact real executable recorded before shim
installation. Shims carry a versioned ownership marker, are written atomically
with owner-only executable permissions, refuse recursion, and never overwrite
or remove an unmarked file. `statecase which`, `statecase bypass`, and shim
verify/uninstall commands keep the indirection observable and reversible.

Pull materialization stages all writes, moves replaced/deleted files to
same-filesystem backups, commits the revision as a set, and rolls back earlier
changes after an apply failure. Manifest tombstones represent remote
deletions. A device may not publish over a non-empty namespace until it has
applied that remote head.

## Alternatives considered

- Harness plugins or source patches: rejected because they couple Statecase to
  harness internals and exclude other agents.
- Shell hooks without a journal: rejected because crashes and offline final
  flushes would silently lose synchronization intent.
- Blocking launch until cloud access succeeds: rejected because Statecase is
  local-first.
- Overwriting binaries in place: rejected because it is unsafe and difficult
  to uninstall reliably.

## Consequences

Ephemeral systems can use foreground supervision without a service manager.
The daemon core supplies locking, filesystem hints, authoritative periodic
reconciliation, remote polling, retry, and private local status for IDE and
non-shim launches. Statecase atomically manages a hardened systemd user unit or
macOS LaunchAgent without invoking a shell. Both definitions pin the installing
Node interpreter instead of relying on the service manager's PATH. Linux
disables systemd environment substitution in ExecStart and escapes specifiers;
both platforms reject path control characters before serialization. Replacing
or removing that Node installation requires reinstalling the service definition.
`daemon start` and `daemon stop` operate only on the installed definition for
the selected local profile. The current product has one native service slot
per OS user: a different STATECASE_HOME cannot take over that slot. Ownership
and the serialized profile binding are checked before replacement, removal,
or manager mutation; a loaded manager path must resolve to the same definition.
Linux stop preserves autostart. macOS stop unloads the job so KeepAlive cannot
respawn it; start enables/bootstrap-loads only when absent and kickstarts
without killing an existing process. Manager inspection failures fail closed.
The launchd diagnostic path parser is deliberately strict and requires native
CI evidence for supported OS versions. CLI JSON acknowledges the request;
`daemon status` establishes process readiness, not successful remote sync.
Linux start/stop, filesystem notification, private IPC, duplicate-writer denial,
and SIGKILL restart passed native UAT on Linux and macOS 26.6.2 arm64. Packaged
systemd/live Cloudflare convergence also passed with two isolated installations
on one host. Separate-host/native-harness convergence and sleep/reboot integration
remain release gates.
The current journal records reconciliation intent; future capsule work will pin the
exact immutable checkpoint associated with each queued publish.

## Security and privacy impact

The journal stores no token, vault key, transcript, path payload, or upstream
error string. Child arguments and environment are passed directly to the child
and are not logged. Shim installation and removal fail closed on symlinks,
unknown files, and self-reference. Transaction staging remains inside the
destination filesystem and is excluded from synchronization.

## Compatibility and migration

Existing manual clients remain compatible. Runtime configuration is an
optional addition to local config version 1. Old clients ignore it. Tombstones
already exist in manifest schema version 1, so no wire migration is required.

## Verification

The supervisor suite verifies ordering, offline behavior, serialization,
signals, exit status, timeouts, recursion, and binary resolution. Shim tests
verify ownership, atomic replacement, quoting, permissions, idempotence, and
safe removal. Sync tests verify delete propagation, modify/delete conflicts,
and unhydrated-push refusal. Fault-injection tests prove rollback after a
mid-transaction failure. The complete suite runs in a `noexec`/`nosuid`
container in addition to the host matrix.
