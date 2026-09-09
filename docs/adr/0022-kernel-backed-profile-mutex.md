# ADR 0022: Kernel-backed profile mutex and atomic owner metadata

Status: implemented; platform/package qualification in progress
Date: 2026-09-08
Test IDs: RT-016, AU-013, WS-001, WS-004

## Problem and failing-first evidence

The original `ProfileLock` read an existing PID/token record, judged its PID
dead, then renamed and removed that path before exclusive creation. Two
processes could both observe the same stale record. A delayed reclaimer could
then rename the new active owner's file and also acquire the lock. A
deterministic regression pauses that delayed reclaimer and reproduces two
successful owners. PID/token checks alone are not atomic compare-and-delete.

The same primitive protects daemon ownership, restore barriers and native
credential migration. Losing exclusion here can undermine otherwise correct
credential CAS or restore boundaries. A second problem is a crash after
exclusive creation but before owner JSON has finished writing: an invalid
record can prevent all future starts.

## Decision

Use the already selected `better-sqlite3` dependency behind a small
`LocalFileMutex` interface in `storage-local`. `runtime` depends on that
interface, not directly on SQLite. No new native binding is introduced.

Each logical `<lock>` has one persistent `<lock>.statecase-lock.sqlite` inode.
A dedicated SQLite connection acquires `BEGIN EXCLUSIVE` with a zero busy
timeout and holds that transaction for the **entire** lock lifetime. This is
not the operation-journal database: holding it never locks `state.db`. There
are no tables, credential values or committed data in the mutex file; current
qualified creation leaves it zero bytes. SQLite validates existing content
before the mutex is accepted. A busy mutex fails promptly. Normal release
closes the connection; process death releases its kernel locks automatically.

Create a new inode privately with `0600`, close its descriptor, hard-link it
into the final name without replacement, and unlink only the unpublished
temporary name. Inspect an existing guard with `lstat`, never ordinary
open/read/close. Reject links, multiple hard links, nonregular files,
group/other permissions and a different owner. Verify the inode identity after
SQLite acquisition. This does not solve arbitrary malicious same-principal
parent/inode replacement or broken filesystem locking.

The descriptor rule matters: on POSIX, closing a non-SQLite descriptor for a
file may release that process's SQLite locks. The
[SQLite corruption guidance](https://www.sqlite.org/howtocorrupt.html) explicitly
warns about such mixed access. Native lock semantics follow
[SQLite's locking implementation](https://www.sqlite.org/lockingv3.html);
the busy timeout uses the existing binding's
[documented API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md).

While holding the kernel mutex, inspect/reclaim owner metadata, fully write
and fsync a private temporary JSON file, then publish it by no-replace hard
link. A crash cannot expose partially written metadata. Kernel ownership is
retained until owner-record cleanup finishes. Failure releases the native
mutex but never deliberately removes a foreign owner record. Crash-created
unpublished metadata temporaries may remain; they contain only PID/token/time,
not credentials, and are not authority for liveness.

The process explicitly retains each acquired `LocalFileMutex` in a strong
registry until successful `release()`. Native binding garbage collection must
not define ownership lifetime: an unresolved async continuation can become
unreachable while the process is alive, causing `better-sqlite3`'s database
destructor to close its SQLite handle. An abandoned mutex therefore fails
closed and remains held until process termination; callers must release in
`finally`. Acquisition failures close their connection without registering it.
This is an in-process lifetime root, not an alternative to kernel exclusion.

Owner metadata is now version two. Its PID is diagnostic, not proof of exclusion;
kernel acquisition permits recovery even if that PID has been reused. Legacy
version-one records are read, and a live legacy PID is respected before any
mutation. Unknown versions, malformed/oversized records, unsafe modes/types,
symlinks and FIFOs fail closed. Metadata reads are nonblocking and bounded to
4 KiB. Recovery rechecks the observed PID/token before removing stale metadata.

## Compatibility, lifecycle and exclusion

- Stop all old Statecase daemons/supervisors/restore operations before upgrading
  a shared local profile. An already-running old stale reclaimer does not obey
  the new mutex protocol. Mixed old/new local writers are not supported.
- Old readers reject version-two owner metadata instead of treating it as a
  compatible PID lock. Remote sync protocol and credential document versions
  are unchanged by this local lock-format change.
- Persistent guard files remain after normal stop/release. Their existence is
  **not** evidence of a running daemon. Use CLI status/private IPC.
- Never remove or replace a guard while any process can use the profile; that
  would create a second lock inode. No automatic guard deletion is implemented.
- Names containing `.statecase-lock.sqlite` followed by end, dot or hyphen are
  reserved case-insensitively, including parent components, native journal
  sidecars and unpublished guard files. Drop sync excludes them before content
  capture; incoming workspace capsules reject them before materialization.
  Do not put the Statecase profile itself in a Drop or network filesystem.
- The local filesystem must provide working SQLite/kernel file locks. NFS or
  a shared network-mounted agent home is not a supported deployment topology.

## Verification and remaining gates

The deterministic stale-reclaimer regression failed first and now passes.
Three separate real-process tests bundle the runtime and use the installed
native SQLite binding: eight restart contenders after SIGKILL admit exactly
one owner; killing a reclaimer before stale removal is recoverable; killing it
after private metadata preparation but before publication is recoverable.
Each test terminates only its own child handles and cleans synthetic roots.
Unit faults also cover ownership changes, failed publication, permission/type
rejection, competing inode publication and safe diagnostics.

CI `34195140316` exposed loss of exclusion at the publication checkpoint in
both Node 24 compatibility and quality. Forcing GC in the exact paused child
reproduced it locally at **both** recovery/publication checkpoints before the
registry fix. Those regressions now require live-owner denial after GC, then
successful acquisition after SIGKILL; ordinary acquisition/release also runs
GC, and the eight-contender test still requires exactly one winner. Earlier
green runs without explicit GC did not establish this lifetime boundary.

The clean-package/native credential test and local authenticated background
drill passed this candidate; see the [qualification report](../uat/2026-09-08-profile-mutex.md).
Exact-candidate platform CI still requires verification. OS power loss/reboot,
further filesystem fault injection, malicious
same-principal replacement, and mixed-version process migration are not proven
by these process-level tests. Workspace transaction crash recovery is a
separate requirement; repairing the mutex does not complete that subsystem.
