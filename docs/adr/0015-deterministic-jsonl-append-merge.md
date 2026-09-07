# ADR 0015: Deterministic client-side JSONL append merge

Status: accepted and implemented for bounded session files
Date: 2026-09-07
Owners: Statecase maintainers
Test IDs: SY-004, SY-005, PR-006
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

Scoped capability clients do not perform this merge. Their updates remain
immutable namespace deltas governed by ADR-0013 and ADR-0014; conflicting
same-path content requires reconciliation by a trusted full-key client.

The current in-memory merge profile rejects any input above 256 MiB or 100,000
records before graph construction. This is a safety bound, not satisfaction of
the multi-gigabyte streaming requirement. Incremental, constant-memory merge
and transfer remain a release gate.

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

The bounded implementation temporarily downloads and decrypts base and remote
session versions. It cannot yet qualify real multi-gigabyte Codex histories.

## Verification

Pure tests cover symmetric convergence, branch partial orders, canonical
deduplication, repeated occurrences, empty/CRLF input, invalid UTF-8, malformed
and incomplete records, rewritten prefixes, incompatible order, safety limits,
and randomized disjoint branches. Two-device integration proves rejected
rewrites do not advance the remote head, merged pushes retain the old applied
marker, dependency activity from both branches enters the Session Capsule, and
verified pull materializes every record exactly once. Malicious oversized
namespace entries are rejected before object download.
