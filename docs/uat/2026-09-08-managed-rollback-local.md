# Managed workspace and file rollback fault qualification

Date: 2026-09-08
Status: local fault suite passed; not a production release qualification
Test IDs: WS-034, BK-008, BK-009

## Candidate and scope

Source is `fef9e7d` plus the current WS-034 managed-advance and rollback
hardening candidate. Tests use generated temporary Git repositories and local
files, real Git 2.43.0, and the actual file materializer. CLI integration tests
use authenticated encryption with an in-memory reference transport. No real
agent state, account credentials, cloud resources, or unrelated processes were
changed by this qualification.

## Failing-first evidence and fixes

1. A branch updated by another process during an injected apply failure was
   overwritten by rollback. Both source and target branch variants reproduced
   this loss. Managed branch mutation/rollback now uses expected-object-ID Git
   updates; restoring HEAD identity no longer rewrites the source branch. An
   independently changed HEAD is preserved and incomplete recovery is reported.
2. A post-install editor write was overwritten by file rollback. Replace,
   delete/recreate, and newly-created-file variants reproduced the loss. The
   materializer now checks the installed object's identity/content before
   undoing it, preserves independent work, and retains the original backup.
3. Retained recovery artifacts would have been published as ordinary Drop
   files. The existing two-device safe-content regression failed with three
   transferred files instead of one. Reserved transaction filenames are now
   excluded, and the receiver obtains only the intended user file.

Additional passing tests cover new/deleted branches, detached/unborn HEAD,
foreign HEAD/ref locks, partial reference-update failure, independent symbolic
HEAD changes, rollback after file removal/directory/symlink substitution, and
rollback of an installed symlink without modifying either referent.

## Complete local quality gate

`npm run check` completed with exit code 0:

- 495 tests in 35 files;
- global branch coverage 90.38% (3187/3526);
- workspace package branches 88.85%, still below its critical-code target;
- file materializer branches 96%;
- lint, TypeScript, bundled build, and clean-prefix package smoke passed.

The operator procedure for retained backups is in `docs/OPERATIONS.md`.
Ad-hoc backup files are plaintext local recovery material, not authenticated
emergency manifests and not evidence of SIGKILL/power-loss recovery.

## Limits

Faults occur at deterministic test boundaries; these tests do not establish
atomic protection from arbitrary concurrent writes between validation and OS
mutation, atomic HEAD exclusion, persistent crash recovery, parent-directory
race safety, or complete multi-root failure handling. Git LFS managed staging,
aggregate resource bounds, package-specific critical coverage, and packaged
live-cloud cross-host native Codex/Claude continuation remain release gates.
The prior native Daytona bundle remains historical evidence for its exact
candidate; later code changes require a native rerun.
