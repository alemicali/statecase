# ADR 0015: Deterministic client-side JSONL append merge

Status: accepted and implemented with streamed common history and bounded suffixes
Date: 2026-09-07
Owners: Statecase maintainers
Test IDs: ID-012, SY-004, SY-005, PR-006
Amends: [ADR-0011](0011-three-way-namespace-merge.md)

## Context

Two full-key devices can append different complete records to the same native
Codex or Claude session while offline. A path-level three-way merge correctly
detects this as a same-path conflict, but treating every such append as manual
would break normal session continuity. Blind concatenation is also unsafe: it
can duplicate shared records, accept a rewritten prefix, discard branch order,
or publish a partial JSONL record.

The service cannot inspect or merge session plaintext without violating
Statecase end-to-end encryption. Scoped sandbox capabilities also must not gain
an implicit same-path replacement primitive under the name `append`.

## Decision

A full-key client MAY merge one recognized portable session file only when all
three authenticated states are available locally: the last revision that this
device actually applied, the current remote head, and the current local file.
The accepted base must be a byte-identical prefix of both branches. Base and
suffixes must be complete, valid JSONL; an invalid UTF-8 sequence, malformed
record, incomplete tail, or rewritten byte fails closed.

Each suffix record is identified by canonical JSON plus its occurrence ordinal.
This deduplicates the same logical occurrence across branches while preserving
intentional repeated records. Edges from each branch retain its record order.
The client computes a deterministic lexicographically ordered topological
merge; a cycle is an order conflict. Equivalent canonical records use the
lexicographically smaller raw representation so reversing client arrival order
cannot change the resulting bytes.

After a successful merge, the client rebuilds the encrypted chunks and content
digest and re-extracts session activity from the merged native records. The new
Session Capsule therefore includes dependencies observed by either branch.
Because the resulting remote state contains bytes not previously present on
the pushing device, that device does not advance its local `applied` marker.
Its next pull may replace the local portable session only after proving that
the remote JSONL is a complete record supersequence containing every local
record occurrence in order. The marker advances only after that verified
materialization.

Portable session identity is independent of a device's native filesystem
layout. Each client keeps a local-only binding from namespace plus portable
logical path to the validated native relative path it scanned or materialized.
The merge result is written back through that binding. A new device uses the
adapter's canonical fallback and then binds it; the originating device retains
its dated/project-native path. Bindings are committed to local configuration
only after successful non-dry-run push, pull, or hydration and are removed with
the corresponding session deletion. They never enter encrypted remote
manifests or API payloads.

Scoped capability clients do not perform this merge. Their updates remain
immutable namespace deltas governed by ADR-0013 and ADR-0014; conflicting
same-path content requires reconciliation by a trusted full-key client.

The common base and both prefix comparisons are processed incrementally. Only
the concurrent suffix of each branch enters the deterministic graph; each
suffix is limited to 256 MiB and 100,000 records. The merged result is emitted
to owner-only staging, and the accepting pull checks record subsequence order
with two-record memory. This makes merge memory independent of total history
size while retaining an explicit bound on concurrent divergence.

## Alternatives considered

- Concatenate suffixes: rejected because it is arrival-order dependent and can
  duplicate shared records.
- Last writer wins: rejected because it destroys one offline branch.
- Merge in the Worker or Durable Object: rejected because it exposes plaintext
  to the service.
- Sort all records without branch-order edges: rejected because native event
  order is semantically meaningful.
- Accept canonical rather than byte-identical prefixes: rejected because a
  rewritten accepted history must remain visible as divergence.
- Give scoped append clients the same merge path: rejected because it would
  blur the distinction between an append proposal and trusted replacement.

## Consequences

Independent complete-record appends converge to the same ciphertext-producing
plaintext on either full-key device without server plaintext. Rewrites and
incompatible record orders remain explicit conflicts: the remote head and
local branch stay intact for inspection and guarded resolution. A successful
merged push intentionally requires a subsequent pull on its originating
device.

The implementation temporarily downloads and decrypts authenticated base and
remote session versions to owner-only staging. Temporary disk therefore needs
space for those inputs and the merged output. A real Daytona acceptance run
qualified a 2,147,483,737-byte common history with two bounded tail uploads and
verified convergence on both native paths.

The local binding prevents a merge from creating a second native file while
leaving the harness-owned original stale. Unsafe, adapter-incompatible, or
colliding binding destinations fail before the materialization transaction.

## Verification

Pure tests cover symmetric convergence, branch partial orders, canonical
deduplication, repeated occurrences, empty/CRLF input, invalid UTF-8, malformed
and incomplete records, rewritten prefixes, incompatible order, safety limits,
randomized disjoint branches, a common base larger than the suffix limit, and
streaming supersequence validation. Two-device integration proves rejected
rewrites do not advance the remote head, merged pushes retain the old applied
marker, dependency activity from both branches enters the Session Capsule, and
verified pull materializes every record exactly once. Malicious oversized
namespace entries are rejected before object download. Device-local tests prove
origin-path writeback, canonical first-pull binding, supervised-final-flush
persistence, deletion cleanup, non-mutating dry-run, traversal rejection, and
pre-apply destination-collision rejection.

## Reviewed native memory representation comparison — 2026-09-08

AD-MEM-011 local return tests reproduced a false conflict after a successful
concurrent merge: the source retained relative memory paths while the incoming
native file localized those same references to absolute paths. The portable
common-prefix check and authenticated merge succeeded, but literal native record
comparison could not prove preservation of the source branch.

The streamed accepting-pull comparator now optionally projects reviewed memory
references on both native sequences to the same logical collection IDs. Each
side has independent per-record cwd state and each record is projected once.
Only the existing reviewed tool fields/raw patch headers can change; content,
prose, output, record occurrences, initial-record identity and branch order stay
part of the comparison. All bytes must still form complete valid bounded JSONL.
Unsupported references, missing context or failed projections refuse the proof;
even unmatched remote tail records must validate. Early refusal closes both
iterators. No transformed copy of the full file is needed.

This refines native materialization equivalence only: authenticated portable
base prefixes must still be byte-identical for the merge itself. It does not
accept an edited portable prefix, migrate unknown old histories or widen scoped
append authority. ADR-0026 separately binds the observed local file to the
precommit boundary, so a successful comparison cannot authorize later edits.

Local tests cover relative structured and raw-patch concurrent returns with each
branch retained once and the old applied marker held until pull, plus missing
duplicates, changed authored content, unsupported remote-tail references and
incomplete local tails. The native Codex drill is extended to fork the original
session on both homes before reconciliation; an executed pass is required
before claiming native concurrent-history qualification.

The native extension passed on `37b1f7b` in job `102034206805` of CI
`34217993203`. Both real source/target continuations retain the original UUID;
the merged push retains the old applied marker and verified pull retains each
contribution once. Both peers subsequently converge with no-op pushes. See the
[bounded report](../uat/2026-09-08-native-memory-patches.md); active-writer,
historical/mixed-client and independent-host cases remain separate requirements.
