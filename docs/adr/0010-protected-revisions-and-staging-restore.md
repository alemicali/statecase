# ADR 0010: Protected revisions and staging restore

Status: accepted
Date: 2026-09-06
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

Users can protect a known-good head and recover historical content to staging
without trusting the current local state. Revision metadata grows until the
retention/GC policy is implemented. In-place restore, scheduled retention tiers,
and garbage collection remain separate release gates.

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
tests cover dry-run, selective historical recovery, non-empty-target consent,
integrity checks, and confirmation that the remote head remains unchanged.
