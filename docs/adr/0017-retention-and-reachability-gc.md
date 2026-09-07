# ADR 0017: UTC retention and opaque reachability garbage collection

Status: accepted
Date: 2026-09-07
Owners: Statecase maintainers
Test IDs: BK-002, BK-003, BK-004, BK-005

## Context

Immutable encrypted objects make deletion recovery possible, but retaining every
upload forever is not operationally viable. The Cloudflare service cannot
decrypt a namespace manifest to discover its object graph or the historical
vault revisions pinned by Session Capsules. A collector that guesses from age
or the current head can silently destroy resumable agent context.

## Decision

Protocol 1.1 namespace commits record server-visible, opaque reachability
metadata alongside the ordered commit decision. The metadata contains the
manifest and required encrypted object IDs, the namespace revision mode and
parent, and any opaque vault revision IDs retained by Session Capsules. It does
not contain plaintext paths, content, keys, prompts, or dependency names.

Retention chooses the newest revision in each UTC bucket: 24 hourly, 30 daily,
and 12 monthly checkpoints. The current scoped head, protected snapshots,
retention checkpoints, and recursively discovered Session Capsule pins are
roots. Snapshot namespace revisions terminate traversal; append deltas retain
their authenticated parent chain. R2 objects are eligible only when they are
outside this graph and older than the 30-day grace period.

The Worker lists only a vault's R2 prefix and asks its vault Durable Object for
the deletion plan. A bounded lease serializes the decision with commits while
R2 deletion runs. Snapshot creation remains safe because it can only protect
the already-rooted current head. Finalization recalculates reachability from
the lease roots, persists the checkpoints, and removes metadata for pruned
revisions. If the Worker stops between R2 deletion and finalization, the
expired lease remains a write barrier. The next collector takes it over,
finalizes the same metadata roots, recalculates the R2 plan, and completes a
new lease before another commit is admitted. A commit never performs this
recovery because the prior Worker could still be deleting.

The Worker runs the collector daily at 03:17 UTC. Owners can run the exact same
path explicitly with `statecase retention plan` and
`statecase retention collect --yes`.

Migration is conservative. Legacy vault-wide objects are never automatically
collected. Namespace history without reachability metadata protects the entire
affected namespace. Objects uploaded before reachability tracking began are
also excluded. This may retain old encrypted bytes but cannot turn an upgrade
into data loss.

## Alternatives considered

- Decrypt manifests in the Worker: rejected because it breaks the E2EE trust
  boundary.
- Delete every object absent from the current manifest: rejected because it
  destroys protected snapshots, append parents, and Session Capsule closures.
- Let a client submit an unaudited deletion list: rejected because a compromised
  writer could bypass server-owned retention and snapshot policy.
- Pause snapshot operations during R2 deletion: rejected because a snapshot can
  only add protection for the already retained current head.

## Consequences

New protocol 1.1 history has bounded automatic storage while maintaining exact
historical closures. The control plane learns relationships between opaque
revision and object identifiers, an accepted metadata disclosure already
implicit in commits. Pre-tracking and legacy data can over-retain and needs an
explicit future backfill/retirement process if reclaiming it becomes necessary.
The first implementation deliberately bounds inventory and graph traversal to
100,000 records and fails without deletion when that limit is exceeded.

## Security and privacy impact

Only owners can invoke collection. R2 inventory stays inside the Worker. The
API returns counts, encrypted byte totals, checkpoint count, and conservative
scope identifiers, not the full object deletion list. A commit racing a live
collector receives retryable `GC_BUSY`; no last-writer-wins window exists.
Unknown history, missing metadata, an oversized graph, or an expired/crashed
operation fails conservatively. An expired operation cannot unblock writes by
itself; takeover requires the scheduled or owner-invoked collector.

## Verification

Pure tests cover UTC buckets across leap day and offset-equivalent timestamps,
clock skew, custom/zero policies, and invalid input. Coordinator tests cover
current heads, protected snapshots, recursive Session Capsule pins, snapshot
and append chains, grace/pending uploads, migration cutoffs, revision-ID reuse,
lease contention/expiry, and metadata pruning. Hono contract tests cover
owner-only preview/collection and `GC_BUSY`. The workerd suite exercises real
Durable Object metadata plus R2 list/delete and proves reachable and legacy
objects survive.
