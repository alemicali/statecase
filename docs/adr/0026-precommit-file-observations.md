# ADR 0026: Bind file preflight to precommit observations

Status: accepted and implemented; native/release qualification in progress
Date: 2026-09-08
Test IDs: SY-012, BK-007..009, AD-MEM-011

## Problem and reproduced evidence

Conflict checks preceded native transaction staging. An unrelated writer could
change or create a destination after preflight but before its rename, and the
ordinary materializer could replace those uncaptured bytes. Eight failing-first
engine regressions reproduced this for streamed sessions, ordinary Drops,
deletion, creation, an initially identical file, incomplete JSONL tails, file
replacement and a symlink substituted during the precommit callback.

## Decision

Capture a local file observation for every ordinary materialized target and
tombstone, including targets absent at preflight. It contains a scope-keyed
digest, native metadata identity and selected-root-to-parent directory identities.
Hash through an explicitly positioned, no-follow/nonblocking file descriptor;
accept only regular files, check descriptor/name/parent stability, bound total
bytes and use a reusable 64 KiB buffer wiped on exit. Missing roots are observed
without creation. A later safe directory created for transaction staging is not
itself a conflict, but a newly present destination file is.

Use the captured digest for streamed-session conflict decisions; buffered reads
must match that captured digest before their bytes can affect a decision. Before
each native write/delete, reobserve that exact target and compare both digest
and identities. Any change or unsafe observation becomes the existing redacted
`SyncConflict` (CLI conflict exit 5). This guard also applies when initial bytes
matched remote bytes or an explicit restore authorized overwriting the initial
state: that authorization does not extend to later changes.

A precommit refusal invokes existing transaction rollback. Earlier installed
targets revert, the changed destination remains untouched, and applied markers
and session bindings do not advance. Existing rollback guards continue to retain
backups if another writer also changed a previously installed target.

Ordinary file observations do not introduce a new permission/ownership policy
for user-selected Drops: group-writable files and hardlinked regular files keep
their existing semantics. Their mode, owner, link count and parent identities
are still part of change detection. Dedicated settings/instruction/memory
policies retain their stricter native ownership, mode and link restrictions.
Symlink/non-directory preflight refusals now surface through the same fixed
conflict contract rather than raw filesystem diagnostics; recovery still stops
before preparation or external writes.

## Efficiency and boundaries

The streamed observation replaces the old standalone local digest pass. A
second linear bounded-memory observation runs immediately before that target's
replacement. No persistent plaintext copy or file-sized buffer is added for
streamed sessions; buffered ordinary-file paths retain their existing limits.
This adds local I/O and still needs qualification at the release's largest-file
and background workloads. Unit chunk bounds are not latency evidence.

These are observations, not an atomic filesystem compare-and-swap or a lock on
an unrelated harness. A non-cooperating writer can still race the final check
and rename or continue writing an already-open descriptor; ancestors above the
selected root, malicious same-user races, post-install changes, uncatchable
process death and durable transaction recovery remain separate release gates.
Do not claim that arbitrary active-writer hydration is safe from these tests.

## Verification

SY-012 verifies all eight engine races plus a change between captured observation
and buffered conflict-read, previous-write rollback, unchanged
configuration, preserved external bytes, bounded chunks and buffer wiping,
growth/truncation during reads, changes after capture, absent-file creation,
parent replacement, metadata/link changes, unsafe file kinds, invalid limits
and redacted diagnostics. Existing historical restore, key-epoch, namespace,
workspace and native lifecycle checks must still pass. Native CI is recorded
separately from these deterministic regressions.

The complete local check passed 891 tests. Candidate `37b1f7b` subsequently
passed all nine jobs of CI `34217993203`, including native Codex/Claude, background
synchronization, workerd/quality and macOS lifecycle/credential checks. This
establishes compatibility with those executed drills, not an active-writer,
largest-file latency, atomic-rename or persistent-recovery guarantee.
