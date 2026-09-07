# ADR 0010: Protected revisions and staging restore

Status: accepted
Date: 2026-09-07
Owners: Statecase maintainers
Test IDs: BK-001, BK-003, BK-005, BK-006, BK-008, BK-009, BK-010

## Context

Bidirectional synchronization propagates valid deletions and therefore cannot
serve as recovery by itself. A safe portability product needs immutable points
that survive head advancement and a recovery path that does not immediately
overwrite live harness state.

## Decision

Every accepted commit stores an addressable revision-to-manifest pointer in the
vault Durable Object as part of the same ordered write as head advancement.
A protected snapshot is an immutable named pointer to the current revision.
Snapshot creation uses a client-generated random ID and is idempotent for the
same ID/name pair. Listing requires vault read access; creation requires write
access; deletion is explicit and owner-only.

The first restore mode is selective staging restore. The caller chooses one
configured harness, Drop, or workspace identity plus an immutable revision and
an explicit target directory. It never changes the remote head or the device's
normal mappings/applied state. Empty targets are accepted; non-empty targets
require `--yes` and remain subject to ordinary dirty/conflict protection. A
dry-run decrypts and validates the recovery plan without materializing files.

The second restore mode replaces one configured two-way Drop or stopped
Codex/Claude mapping in place on a full-key device. It is never implicit:
`--in-place` selects it, dry-run previews it, and mutation requires `--yes`.
The CLI excludes the profile daemon with its normal lock and excludes harness
writers with a multi-reader activity registry, an exclusive restore barrier,
and a direct process-table check. Unknown or malformed activity state fails
closed. SQLite database, WAL, and SHM targets are refused.

Before local mutation, the client creates a protected snapshot of the current
remote head and an owner-only persistent emergency snapshot containing exactly
the paths the transaction can replace or delete. Files are copied and fsynced,
then size, digest, and source stability are verified; missing paths and
symlinks are also recorded. Materialization is transactional and adapter output
is rescanned and matched to authenticated object digests. Failure after
mutation invokes the emergency rollback. Success commits a fresh namespace and
vault revision parented from the current head, so history is forked forward
rather than moving the shared head backward. Historical Session Capsule pins
are preserved.

Emergency snapshots remain available for explicit offline rollback with
`statecase emergency rollback <path> --yes`. The same daemon/harness exclusion
rules apply. Workspace in-place restore is deferred because Git index,
worktree, submodule, and overlay rollback require the workspace transaction
contract; workspace restore remains available to staging.

## Alternatives considered

- Treat current R2 objects as backup: rejected because object IDs alone do not
  reconstruct a coherent historical revision.
- Move the remote head backward: rejected because other devices could silently
  lose newer work and immediately race it forward again.
- Restore every namespace together: rejected as the only mode because recovery
  frequently needs one project or harness and broader writes increase risk.
- Allow snapshot deletion to any writer: rejected because protected retention
  must resist a compromised ordinary writer.

## Consequences

Users can protect a known-good head, inspect historical content in staging, and
recover Drops or stopped harness state without trusting the current local
bytes. Scheduled retention and reachability garbage collection are defined by
ADR-0017. Workspace in-place restore and real-version harness UAT remain
release gates; the live Drop path is qualified in the Daytona/Cloudflare UAT.

## Security and privacy impact

The service stores only opaque manifest pointers, names, timestamps, and IDs;
payloads remain client-encrypted. Unauthorized and non-owner snapshot deletion
uses not-found semantics. Restore uses the existing authenticated decryption,
path containment, special-file filtering, baseline checks, and all-or-rollback
materialization path.

## Verification

Core tests cover head advancement, old-revision lookup, no-head behavior,
idempotent snapshot creation, ID conflicts, deletion, and coordinator restart
storage. API tests cover authorization and not-found behavior. CLI/integration
tests cover dry-run, selective staging recovery, non-empty-target consent,
daemon/harness exclusion, SQLite refusal, exact deletion and resurrection,
tamper detection before mutation, failed-commit emergency rollback, explicit
offline rollback, Session Capsule preservation, and the new forward revision
observed by a third client.
