# ADR 0030: Persistent file-materialization replay

Status: internal primitive implemented; CLI/Git/profile integration remains open
Date: 2026-09-08
Test IDs: RT-006, BK-008, BK-009, WS-025, WS-034, IS-004

## Context and decision

ADR-0029 made retained recovery artifacts exclusively owned, but process death
still lost the in-memory transaction plan. Recovering a file transaction needs
durable intent distinguishing an unstarted rename, an original moved to backup,
an installed incoming file and a committed transaction awaiting cleanup.

Introduce `applyRecoverableFileTransaction` and `recoverFileTransactions` as
internal primitives composed with the existing materializer. They require an
explicit private journal directory outside explicit approved native roots.
They are **not yet wired into normal CLI sync, shims or daemon execution**.
The outer transaction must also cover Git metadata, session bindings, applied
profile markers, native activity and recovery barriers before enabling them.

The coordinator uses the existing kernel-backed profile mutex, not PID leases,
to serialize cooperating materialization and recovery processes. Preview performs
bounded read-only inspection without creating a profile, journal or lock. It is
informational, not permission to mutate while another process is active.

## Journal protocol

1. Prepare same-filesystem artifacts using ADR-0029. Capture the explicit root,
   parent identities, artifact identity and prepared-file fingerprint per target.
2. Serialize the complete version-one plan once into a private exclusive temporary
   file, fsync it, check the active destination is absent, atomically rename the
   plan to `active.jsonl` and fsync its directory. No original is moved before this.
3. Before each mutation, append an ordered intent with the original fingerprint
   and any newly reserved deletion artifact. Fsync before proceeding. Re-run the
   caller conflict guard, check the recorded original again and compare the
   pre-intent metadata observation. Persisting intent grants no overwrite authority.
4. Move the original to its private backup, then install prepared content or leave
   a deletion absent. Synchronize destination/artifact directories at each step.
5. After all mutations, append and fsync the commit record before cleanup. An
   ambiguous commit/acknowledgement failure retains files and journal; never roll
   back automatically after a possibly persisted commit.
6. Reuse the recovery validator for guarded cleanup, then remove the journal and
   fsync its directory. A caught precommit/apply failure first restores originals
   and synchronizes their directories; interruption retains replayable intent.

Default materialization remains non-journaled. Lifecycle callbacks are internal
composition points, not public CLI fault-injection flags.

## Replay semantics

Validate the complete journal, approved roots, canonical target/artifact paths,
parent identities, artifact identity/inventory and relevant fingerprints before
the first recovery mutation. Reobserve each target immediately before its action.
Reverse-order replay distinguishes:

- original already present with no backup: unstarted or previously rolled back;
- exact original backup and expected incoming/absent destination: restore backup;
- originally absent destination containing the exact installed inode/content:
  remove that installation;
- committed journal: preserve current destinations, clean only verified artifacts;
- ambiguous, missing or independently modified evidence: retain state and refuse.

Replay can resume in a new process after recovery itself is killed. A completed
replay is a no-op on the next invocation. A new cooperating transaction first
recovers pending work and refuses to proceed when recovery cannot be established.
Independent post-crash edits and observed writes through an already-open original
descriptor retain changed work and available backups. This is observational
protection, not a lock on arbitrary native writers.

## Bounds, efficiency and privacy

The plan is written once and each target appends one small intent: journal writes
are linear in target count, not a complete manifest rewrite per operation. The
journal is limited to 32 MiB and 100,000 entries. Schema/version, record order,
duplicate targets, extra fields and UTF-8 are validated. Only an incomplete final
append is ignored; a following mutation cannot have been authorized by an append
that did not finish. Malformed complete records or unsupported plans are refused.
This is not cryptographic journal integrity or tamper-proof local storage.

Journal reads use a bounded, private, owner-only, single-link, no-follow,
nonblocking descriptor with descriptor/name stability checks. Absolute paths,
identities and hashes are private local metadata; payload bytes are not journaled.
Neither metadata nor backups are uploaded. Unsafe files, links, directories and
oversize/invalid records fail closed with fixed recovery errors.

Materialization fingerprints now use positioned bounded reads through a no-follow,
nonblocking descriptor, a reused/wiped 64 KiB buffer and a 20 GiB file bound.
Descriptor/name and metadata stability are checked. Rename-compatible fingerprints
omit ctime but include inode, mode, owner, link count, size, mtime and content.
Symlink targets are observed without following their referents. Additional local
hashing/fsync costs require largest-workload qualification; small correctness
fixtures establish no performance claim.

## Alternatives, consequences and compatibility

- Unconditional rollback after every exception loses the distinction between a
  failed commit and a committed transaction whose acknowledgement failed.
- Scanning native trees for filenames cannot establish complete transaction
  authority or safely interpret unrelated historical artifacts.
- Rewriting a complete plan before every target costs quadratic journal I/O.
- A file-only commit cannot substitute for the required outer Git/profile commit.

Use this focused append journal for file transactions; the existing SQLite
reconciliation journal remains unchanged. There is no new runtime dependency,
cloud schema, wire capability or released profile migration in this internal step.
Compatibility/fencing decisions are required before normal runtime integration.
Retained plaintext artifacts still consume local disk and must not be pruned
indiscriminately. They are not authenticated emergency snapshots.

## Evidence and remaining gates

The failing-first suite initially had no recovery implementation to import.
Tests build the actual module into an isolated executable fixture, terminate the
writer with real SIGKILL and recover in a separate process. They cover published
preparation, intent/backup/install/commit boundaries, repeated interruption of
recovery, create/delete/symlink operations, two roots, caught rollback failures,
commit acknowledgement ambiguity, preview, active-writer serialization, corrupt
journals, authority escapes and independently changed work, including a real
already-open original descriptor. Timeout termination never counts as a pass.

These tests do **not** close full RT-006. Remaining requirements include:

- Git HEAD/refs/index, native activity and outer applied-profile/session-binding
  coordination, plus ordinary CLI/daemon/shim integration;
- interruption of every low-level write/fsync/close and actual power-loss behavior;
- orphan cleanup for artifacts or unpublished plan temporaries created before
  the complete plan becomes discoverable (originals have not been moved then);
- ancestry above approved boundaries, malicious same-principal replacement inside
  final check-to-mutation windows, arbitrary active descriptor writers, disk-full
  and read-only faults at every transition, and journal tampering;
- packaged cross-host/live-cloud and largest-file performance qualification.

Initial-plan publication is an observed absent-target rename under the cooperating
mutex, not a no-replace/CAS primitive against an uncooperative writer. Do not remove
retained journals or recovery artifacts as an automatic error remedy.
