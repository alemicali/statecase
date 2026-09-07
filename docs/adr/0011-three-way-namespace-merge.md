# ADR 0011: Three-way namespace merge and guarded local resolution

Status: accepted
Date: 2026-09-06
Owners: Statecase maintainers
Test IDs: SY-002, SY-003, SY-004, SY-005, SY-006, SY-007, AU-006, UAT-05

## Context

An optimistic head prevents corruption but is not sufficient for a multi-device
product. Two offline machines commonly create different session files or edit
different Drops. Rejecting every stale writer would make normal portability
manual, while last-writer-wins would silently lose context.

## Decision

Each writable namespace uses the revision the device last actually applied as
its merge base. Entries are compared through authenticated, scope-local content
digests and canonical metadata; plaintext need not reach the service. For every
logical path, a one-sided change wins, equal concurrent content converges, and
different two-sided changes produce an explicit conflict. Workspace capsule
transport entries are one atomic unit until a Git-aware overlay merge is
implemented.

A merged push is marked applied locally only when its resulting namespace is
identical to the local filesystem snapshot. If the merge retained remote state,
the old applied marker remains so the next pull hydrates it. A first writer may
not merge over an existing namespace it has never applied.

Append-only mappings may add new paths but may not overwrite, delete, or
resurrect a prior tombstone. Same-path resolution never happens implicitly.
The explicit local-winner command first creates a protected snapshot, then
requires the head used by the merge to equal the snapshotted revision. Head
movement aborts resolution instead of exposing a race window.

## Alternatives considered

- Reject every stale head: safe but unusable for ordinary offline work.
- Last writer wins: rejected because it destroys sessions and working context.
- Merge encrypted bytes on the Worker: impossible without violating E2EE.
- Treat staged/worktree blobs as independent merge paths: rejected because a
  mixed workspace capsule may not correspond to any valid Git state.

## Consequences

Different files and different session artifacts converge without coordination.
Conflicting same-path variants remain available at the remote head and local
filesystem; staging restore provides inspection before resolution. Concurrent
complete-record appends to the same native JSONL are handled by the bounded,
full-key client algorithm in ADR-0015. Parser-safe text merge remains a
separate feature rather than unsafe concatenation.

## Security and privacy impact

Merge decisions use authenticated encrypted-manifest metadata, never server
plaintext. Unhydrated devices fail closed. An append-only writer cannot express
delete/overwrite through the client policy; server-enforced scoped capability
authorization remains required before hostile sandbox claims are made.

## Verification

Pure tests cover both one-sided directions, identical objects, disjoint paths,
modify/modify, modify/delete, tombstones, append-only policy, deterministic
ordering, and atomic workspaces. Multi-device tests prove convergence, retained
applied markers, explicit conflict paths, protected local resolution, and
expected-head race rejection.
