# ADR 0029: Exclusively owned materialization artifacts

Status: implemented prerequisite; durable replay remains required
Date: 2026-09-08
Test IDs: RT-006, BK-008, BK-009, WS-025, WS-034, IS-004

## Problem and failing-first evidence

Before introducing persistent materialization recovery, artifact ownership must
be reliable. Three failing-first tests reproduced deletion of a pre-existing
staging file, deletion of a pre-existing staging symlink, and overwriting then
deleting a pre-existing recovery backup. Random UUIDs make accidental collisions
unlikely, but do not authorize deleting a pathname after exclusive creation
failed. The previous implementation recorded staging ownership too early and
used an overwriting rename to an unreserved backup pathname.

## Decision

Reserve `<target>.statecase-transaction-<uuid>.staged` with a non-recursive,
exclusive directory creation, mode `0700`, on the destination filesystem.
Record directory identity only after successful creation and observation.
Prepare new content as `prepared` and move the original to `backup` inside that
owned directory. Existing files, directories and symlinks at the reservation
name are never adopted or cleaned up. Legacy sibling `.backup` files are neither
overwritten nor removed. Missing deletion targets need no reservation.

Recheck directory type, device, inode, mode and owner before commit, rollback
and cleanup. An observed substitution retains artifacts and refuses further
mutation. Cleanup inspects the child-name inventory before deletion, removes
only known children and uses non-recursive `rmdir`; unknown children are not
deleted. Incomplete rollback retains the private directory containing the
original. Existing case-insensitive reserved-component policies also exclude
the directory and all its descendants from ordinary synchronization and reject
remote materialization into it. No new wire path or native file format is added.

## Alternatives and consequences

- Checking existence before rename is not exclusive reservation and leaves an
  avoidable overwrite race; rejected.
- Keeping sibling staging files but marking ownership after `open` fixes the
  first bug but does not reserve backup destinations; insufficient alone.
- Recursive deletion of the reservation would remove unexpected children;
  rejected in favor of explicit known-child cleanup and `rmdir`.

The additional private directory costs a local mkdir/rmdir per affected target
and keeps staged/original bytes behind an owner-only traversal boundary. No
dependency, network request or plaintext service metadata is added. Retained
artifacts still consume disk and must not be indiscriminately pruned.

## Compatibility and rollback

Ordinary sync already excludes reserved artifact names in every path component,
so the new descendants remain local without a protocol change. Historical
artifacts are preserved, not migrated. Operator guidance identifies both layouts;
neither is input to `emergency rollback`. Do not downgrade and retry a partially
materialized transaction expecting an old binary to discover or recover it.

## Evidence and remaining work

The isolated test process bundles the real materializer, receives only synthetic
home paths and terminates itself with actual `SIGKILL` at the second target's
precommit boundary. The parent observes the signal (a timeout is a failure),
checks that the first target contains the installed bytes, the second retains
its original, and the first original survives exactly inside a private recovery
directory. This intentionally establishes retained recovery material, **not**
successful replay: native state is still partial at that boundary.

Full RT-006 requires a durable validated intent record, restart discovery,
idempotent recovery at every mutation transition, and coordination with Git
HEAD/refs/index, multi-root state, session bindings and applied config markers.
That work is not implemented by this ownership prerequisite. Power-loss fsync
ordering, already-open descriptor writers, final check-to-mutation races and
malicious same-principal directory changes remain separate qualification gates.
No automatic cleanup or recovery of historical orphan artifacts is introduced.
Retained files are local plaintext, not authenticated emergency snapshots.

Boundary tests cover reservation collisions, a later reservation failure after
an earlier successful preparation, directory/symlink/file/missing substitutions,
unknown children, ordinary rollback, independent editor changes, link rollback,
actual process death and encrypted Drop transfer excluding nested artifacts.
