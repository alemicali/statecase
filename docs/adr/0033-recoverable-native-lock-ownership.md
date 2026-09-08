# ADR 0033: Record native lock ownership before publication

Status: internal native-lock primitive implemented; outer Git integration pending
Date: 2026-09-08
Test IDs: RT-006, WS-034, BK-009

## Context and failing-first evidence

ADR-0032 prepares the workspace without holding an unjournaled native index lock.
The next coordinator must acquire native writer exclusion only after durable
intent and recover its own lock after process death. Creating `index.lock` first
and recording its inode later leaves an interruption gap. PID expiry, file age,
or equal file content cannot justify deleting another writer's lock.

The initial suite failed because the ownership API did not exist. A later
regression proved repeated acquisition skipped its directory-durable boundary;
repeated release had the corresponding gap after a crash between unlink and
directory fsync. Both repeated operations now synchronize the native parent
before acknowledgement. No test infers process death from a stale PID.

## Decision

Add internal `prepareNativeLock`, `acquireNativeLock` and `releaseNativeLock`.
They require independently derived exact path/root grants; a serialized plan
cannot grant itself authority. The outer coordinator must hold its existing
kernel-backed transaction mutex throughout acquisition, native mutations and
recovery, and durably publish each returned plan before acquisition. These
functions deliberately do not invent a second PID lease or transaction decision.

Preparation exclusively creates a private sibling directory:
`<native-lock>.statecase-transaction-<uuid>.staged/anchor`. The existing reserved
artifact naming scheme excludes it from ordinary transfer. The anchor contains
only a format marker and UUID, not native index bytes, credentials or agent data.
It is written and fsynced with mode 0600 inside a 0700 directory; the directory
and native parent are fsynced before returning its descriptor.

The version-one strict descriptor contains root/path, bounded parent identity
observations, exclusive artifact identity and anchor fingerprint. Device/inode
identities use BigInt stat values, avoiding Number rounding. Persisted anchor
identity includes mode, owner, size and nanosecond mtime, but not nlink/ctime,
which legitimately change when publishing a hard link. Individual observations
also require stable nlink/ctime through the bounded descriptor read.

Only after the caller records that descriptor durably, publish the native lock
with an exclusive hard link from the anchor to the native path. This establishes
ownership of the inode *before* it becomes a native lock and keeps publication
on the same filesystem. A pre-existing destination is never overwritten. Observe
both names and synchronize the native parent before acknowledging acquisition.
Repeated acquisition recognizes only the proven existing inode and still fsyncs
the parent, because a preceding process may have died before that fsync.

## Recovery and refusal

Validate the whole descriptor and exact grants, complete parent chain, exclusive
artifact identity/inventory, private ownership, link counts, exact marker bytes
and stable no-follow/nonblocking descriptor observations before mutation. Reads
are bounded by the fixed marker size and never read a foreign lock whose inode
does not match. More than two links, a missing anchor under a held lock, substituted
parents/artifacts, symbolic links, changed bytes/modes, unknown children or foreign
native locks refuse with fixed `NATIVE_LOCK_RECOVERY_REQUIRED` diagnostics.

Release removes the matching native link first and fsyncs its parent, then removes
the anchor and its now-empty private directory with non-recursive operations.
Recovery can repeat after each unlink/removal. Even when all names are already
absent, fsync the native parent before acknowledging release. The descriptor must
remain in the outer journal until that acknowledgement. A retired descriptor
cannot be used to acquire a new lock. Preview validates without creating,
linking, unlinking, locking or syncing anything; allocating/acquiring in preview
is explicitly refused.

The primitive accepts at most 128 exact grants, canonical paths up to 4096
characters and at most 64 already-existing native parent directories. It does
not create missing native parent chains. Descriptor fields and arrays are
bounded; the eventual outer reader must enforce its own byte bound and privacy
checks before parsing. Native lock and ownership descriptors never enter cloud
storage. Unsupported hard-link/durability operations fail closed.

## Alternatives and remaining requirements

- Recording ownership after native lock creation leaves a crash ambiguity.
- Matching only bytes can remove a newly recreated independent lock.
- Using only PID/mtime can steal a live or unrelated writer's exclusion.
- Removing unknown directory contents destroys evidence not owned by this operation.
- Returning early for already-visible link/unlink results skips durability replay.

This is an internal ownership primitive, not a standalone public recovery command.
The tests persist descriptors in synthetic intent files; the production
file/profile checkpoint does not yet contain them. Complete repository-derived
Git metadata authority, durable outer lock descriptors, HEAD/ref/index intents,
retained commit roots and shared rollback/commit ordering before runtime enablement.
The current ordinary workspace index-lock helper is deliberately unchanged until
that outer intent exists. The primitive is not safe for concurrent acquire/release
of one plan without the required outer mutex.

Failure before descriptor publication may retain nonblocking private orphan
staging; do not scan/delete it based on names alone. Full orphan handling, native
parent creation, power loss and all filesystem/Git syscall boundaries, same-user
check-to-unlink races, activity barriers, mixed clients, cross-host/live-cloud UAT
and independent security review remain requirements. Observational inode checks
are not an atomic filesystem CAS against arbitrary malicious local processes.
There is no new dependency, cloud/profile schema, native harness patch or public
CLI contract in this slice.

## Verification

Synthetic repositories demonstrate that the lock prevents a real `git add` and
that guarded release allows it again. The actual module is bundled into child
processes. Tests fsync a private intent file and its directory before publication,
then use actual SIGKILL before linking, after link creation and after directory
durability. Fresh processes recover; recovery itself is killed after native
unlink, anchor unlink, artifact removal and release durability. Timeouts never
count as process-death evidence. Tests additionally cover previews, idempotence,
retired plans, foreign/recreated locks, changed bytes/modes, extra links, unknown
children, parent/artifact substitution, malformed descriptors, exact grant limits,
allocation collision, nested/missing/symlink parents and caught-boundary failures.

The complete local check passed 1,159 tests in 68 files, lint, types, build and
clean-installed package smoke. New module branches are 95.69% with 100% lines and
functions; global branches are 92.79%. The same suite is now required on the
disposable macOS CI runner in addition to Linux quality/runtime jobs. Hosted
exact-candidate evidence remains required; these tests do not qualify applied-Git
replay or normal-runtime integration.
