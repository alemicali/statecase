# ADR 0014: Namespace snapshot and append-delta chains

Status: accepted and implemented for current heads

## Context

A sandbox with append authority must be able to return work in progress, but
must not receive unrestricted namespace replacement authority. Treating a
modified workspace path as a direct append would either reject useful work or
silently weaken append into write. A fresh reader also needs the complete state
after one or more sandbox publications.

## Decision

Each namespace head points to an end-to-end encrypted manifest. A trusted
writer publishes a complete `snapshot`; a scoped append client publishes a
`delta` whose single parent is the head it reconciled against. Delta entries
are upserts and tombstones are deletion proposals. The server sees only an
immutable blinded patch-record claim, encrypted object identifiers, and the
parent/head identifiers.

The coordinator stores an immutable namespace revision pointer containing the
manifest object and previous namespace revision. Readers walk at most 256
revisions, reject cycles, require a snapshot base, authenticate every envelope,
verify each manifest against its pointer, and apply deltas oldest to newest.
Namespace objects remain physically isolated in R2.

Full-key writers use three-way merge against the last namespace revision they
actually applied. Compatible offline changes converge; same-path divergence
remains a conflict. Their next write emits a new snapshot, naturally compacting
the active read chain without deleting immutable history.

## Consequences

Append means “add an immutable proposed state transition”, not “overwrite the
canonical server state”. This permits useful sandbox edits and deletions while
preserving reviewable ancestry and limiting authority. Retention/GC must retain
the snapshot base and every reachable delta, plus protected historical roots.
Historical scoped restore and protected scoped snapshots retain the required
roots. Retention/GC remains required before old protocol 1.0 data and routes
can be retired.

## Verification

Protocol tests enforce namespace containment, unique claims, and additive
claim mutations. Coordinator/API tests cover immutable revision lookup and
cross-namespace denial. CLI tests prove a root-key publisher can migrate a
namespace, a rootless capability can pull and append a modified/new file using
only namespace routes, a fresh reader reconstructs the chain, and a persistent
device receives the sandbox result.
