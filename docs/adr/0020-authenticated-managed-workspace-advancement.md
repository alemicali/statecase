# ADR 0020: Authenticated managed workspace advancement

Status: implementation and qualification in progress; not release-qualified
Date: 2026-09-08
Owners: Statecase maintainers
Test IDs: WS-034, UAT-02

## Context

A transferred working tree is normally Git-dirty. Requiring a clean checkout
for every pull makes the core A → B → A continuation fail even when A has made
no further edits. Dirty status alone cannot distinguish unsynchronized work
from the exact overlay Statecase already applied. Explicit historical restore
is not an appropriate workaround for ordinary synchronization.

## Decision

Keep the clean-checkout path for initial materialization. Permit an ordinary
managed advance only when the complete current capsule matches the exact
authenticated last-applied namespace revision. Authenticate prior metadata and
compare local capsule/blob content digests, modes, paths, and layers. A local
digest map, the latest remote head, or a newly captured workspace alone is not
overwrite authority. Missing or corrupt history fails closed. Built-in-excluded
local changes do not silently disappear from this safety comparison.

Preflight all roots and the existing device-local baseline acquisition policy.
Prepare the target index in a private temporary directory using `GIT_INDEX_FILE`;
do not reset or check out over the managed dirty working tree. The write set is
the union of prior overlay paths, new overlay paths, and changed baseline paths.
Paths removed from the overlay must return to their baseline state or disappear
when untracked; staged and working-tree bytes remain independent.

Acquire the worktree-specific Git index lock exclusively and keep it through
materialization/rollback. Never break an existing lock. Cleanup removes only
the lock inode owned by this operation. Recheck the capsule after preparation;
fingerprint planned targets and require the materializer to check each target
immediately before replacing it. This catches tested editor writes during
staging but is not a claim of filesystem-wide exclusion of arbitrary writers.
Apply ordinary files, workspace files, and the prepared index in the same
all-or-rollback materializer. Restore affected branch/HEAD metadata if that
materializer fails. Advance applied markers only after successful completion.

Branch updates and their rollback use Git expected-old-value compare-and-swap,
including creation and deletion. Restoring HEAD identity does not rewrite the
original branch: that branch may have advanced independently. If HEAD changed
independently, rollback refuses to overwrite it and reports incomplete recovery.
Git's documented semantics are described in
[git-update-ref](https://git-scm.com/docs/git-update-ref).

The file materializer fingerprints staged content, inode identity, mode, and
mtime. During rollback it removes a committed replacement only while it still
matches that installed state. A new local write, type change, or independently
recreated deleted file is preserved; the original backup is retained and the
operation fails with an incomplete-rollback error. Failed rollback cleanup MUST
NOT delete available recovery backups. Transaction artifact names are reserved
and excluded from ordinary publication and inbound materialization. These are
local recovery files, not an authenticated emergency snapshot manifest.

Directory/special-file collisions, unobserved ignored content, unsafe symlinks,
and initialized submodules remain fail-closed. An LFS pointer is never content.

## Alternatives rejected

- Ignore Git dirty status: destroys new local work.
- Trust only local applied digests: does not authenticate the expected state.
- Force reset or invoke historical restore on each pull: changes the consent
  and recovery model and makes normal device switching unnecessarily destructive.
- Copy `.git`: violates the local identity and credential boundary.

## Qualification still required

The initial WS-034 regression, preview, new-local-edit refusals, missing/corrupt
history, ordinary mid-commit rollback, baseline policy, HEAD rollback, index
lock ownership, and selected editor-race tests now have local evidence.
This is not yet full qualification. Remaining gates include:

- packaged live-cloud cross-host continuation (native engine-level return sync
  now passes in a fresh Daytona sandbox with a reference backend);
- persistent interrupted-transaction recovery and atomic HEAD exclusion across
  metadata changes (branch compare-and-swap alone is not enough);
- races inside check-to-rename/check-to-rollback boundaries, parent-directory
  races, and multi-root commit fault coverage (tested post-install editor writes
  now retain both local work and original backup rather than overwriting either);
- managed-path LFS acquisition without modifying the prior worktree;
- bounded aggregate baseline staging and supported directory transitions;
- required critical branch coverage and full release quality checks.

These gaps must be closed, not waived by the passing simple return-sync case.

The latest full local check passed 495 tests and 90.38% global branch coverage;
the workspace package remains at 88.85% branches, below its critical-code target.
The file materializer is at 96% branches. This later branch/rollback-hardening
candidate needs a native CI rerun; the prior Daytona result does not qualify
subsequent code changes automatically.
The executed native bundle and precise isolation limits are recorded in
`docs/uat/2026-09-08-native-codex-resume.md`.
