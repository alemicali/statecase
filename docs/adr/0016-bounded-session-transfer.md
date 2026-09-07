# ADR 0016: Bounded session transfer and tail reuse

Status: accepted
Date: 2026-09-07
Owners: Statecase maintainers
Test IDs: AD-CX-003 through AD-CX-008, PR-007, PERF-003, SY-003 through SY-005

## Context

Native Codex session files can exceed one gigabyte. Reading a complete session,
all plaintext chunks, or all encrypted envelopes into memory makes sync unsafe
on local machines and ephemeral sandboxes. Re-uploading every object after a
small append also defeats the product's continuity goal.

## Decision

New vaults start on namespace protocol 1.1. Recognized JSONL is copied into an
owner-only temporary staging directory one complete record at a time; an
incomplete live tail is excluded. Absolute workspace paths are transformed per
record. A keyed incremental digest preserves the existing v1 object identity.

Session objects use deterministic record-aware chunks with a 4 MiB target and
4 MiB hard ceiling. Records over the ceiling are split deterministically.
Manifests record the strategy and parameters while keeping the descriptor
optional for backward compatibility. Upload compares object IDs with the
authenticated remote namespace manifest, encrypts and sends only missing
objects one at a time, and always commits the complete ordered object list.

Pull downloads and decrypts one object at a time into secure staging, validates
the declared size and whole-file keyed digest, performs record-by-record path
localization, and atomically installs from the verified file rather than a RAM
buffer. The session limit is 20 GiB and the single-record parser bound is 64
MiB. Existing protocol 1.0 heads keep their migration path.

Every plaintext staging allocation first checks available blocks on the target
temporary filesystem. The required copy count plus a 64-MiB safety reserve must
fit. Capacity is rechecked as download, localization, merge, and atomic
materialization artifacts accumulate; this does not replace fail-clean handling
if free space changes.

## Consequences

Memory use is bounded by one JSONL record plus one plaintext/encrypted object,
independent of session size. Appending normally replaces only the underfilled
last chunk and adds new tail chunks. Temporary disk use can approach twice the
portable session size during localization and must be available before apply.
Orphaned encrypted objects may remain after a failed commit and are safe for
later garbage collection.

Concurrent three-way append merge streams the common base and limits only each
concurrent suffix to 256 MiB and 100,000 records. A literal 2-GiB acceptance
test is still required before claiming full multi-gigabyte conflict merge.

## Security and privacy impact

Temporary files use unpredictable directories and mode 0600. Plaintext never
leaves the client. AEAD authentication, requested namespace context, declared
size, and the incremental whole-file digest are verified before filesystem
mutation. Portable workspace URI components are validated before resolution;
traversal and ambiguous separators fail closed. Corrupt or incomplete downloads
are deleted and fail closed.

## Verification

Unit and integration tests cover arbitrary source segmentation, oversized and
unterminated records, digest equivalence, dry-run behavior, missing-object
invariants, corrupt ciphertext, false declared sizes/digests, staging cleanup,
atomic file-backed installation, workspace-bound and unbound sessions, legacy
migration, absence of redundant object PUTs after append, and disk-capacity
boundary calculations for numeric and bigint filesystem counters.
