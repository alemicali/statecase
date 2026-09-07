# ADR 0018: Recoverable Git workspace replacement

Status: accepted
Date: 2026-09-07
Owners: Statecase maintainers
Test IDs: BK-009, WS-014, WS-015, WS-018, WS-033

## Context

A staging restore can inspect a historical Git capsule safely, but it does not
put an existing agent checkout back into the exact operational state required
to resume work. Replacing only worktree files is insufficient: the historical
commit, symbolic or detached HEAD, index, tracked deletions, and untracked files
must move together. A failure after local replacement but before the remote
forward commit must not strand the operator in a half-restored repository.

## Decision

Allow explicit in-place restore for a configured `git-overlay` workspace on a
full-key device. It uses the same `--in-place --yes`, profile lock, protected
cloud snapshot, authenticated historical manifest, validation, and forward
fork semantics as Drop and harness restore.

Before mutation, Statecase validates the capsule and every blob, the device's
`ask|auto|never` baseline policy, branch identity, path containment, entry
types, and initialized-submodule boundaries. The replacement plan is the union
of current index/worktree/untracked changes, target capsule records, and paths
whose tracked baseline differs between the current and target commits.

The local emergency snapshot records that exact path set plus:

- the original commit and symbolic or detached HEAD state;
- the raw worktree-specific Git index with size and SHA-256 verification;
- the original value or absence of every branch ref the replacement can move;
- private recovery refs that keep commits reachable while the snapshot exists.

Statecase rechecks HEAD, affected refs, index, and every captured worktree entry
after copying. Any concurrent change aborts before replacement. It then removes
only planned entries, installs the exact baseline, reproduces the target HEAD,
and applies index and worktree overlays independently. Adapter-level capsule
recapture must match the authenticated remote entries before the coordinator
accepts a new namespace and vault revision. Any later validation or optimistic
commit failure restores files, refs, HEAD, and index from the local snapshot.

Initialized submodule worktrees remain fail-closed. An uninitialized gitlink is
an index record and remains supported; nested repository contents are never
copied, removed, or hydrated.

## Alternatives considered

- Copy `.git`: rejected because it transfers credentials, locks, object-store
  layout, worktree paths, and unrelated local repository state.
- Run `git reset --hard` without persistent recovery: rejected because it loses
  current work and cannot recover after a cloud commit race.
- Restore worktree bytes but leave HEAD/index unchanged: rejected because the
  resumed agent would observe a different staged and baseline state.
- Rewind the cloud head to the historical revision: rejected because other
  devices could lose newer history and race it forward again.

## Consequences

Historical workspace recovery is destructive only after explicit consent and
is locally reversible offline. Recovery snapshots and their private refs remain
until the operator deliberately removes the recovery artifact; this consumes
local disk but prevents garbage collection from invalidating rollback. The
packaged Cloudflare/Daytona qualification passed; initialized submodule
hydration and real-harness recovery remain separate release gates.

## Security and privacy impact

The service still receives no repository paths, Git remotes, credentials,
plaintext files, or index bytes. System Git uses only the existing local
checkout and credential helpers under the approved fetch policy. Incoming
paths, symlinks, modes, object IDs, and branch names are untrusted and validated
before mutation. Special files, directory collisions, and initialized
submodules fail closed.

## Verification

Automated tests cover dirty same- and different-baseline replacement, staged
versus worktree divergence, deletes, executable and binary-safe paths, safe
symlinks, untracked removal, detached and unborn HEAD, branch movement, missing
baseline policy/fetch, initialized gitlinks versus submodules, directory/FIFO
refusal, non-Git and malformed capsules, dry-run, CLI consent, exact emergency
rollback, failed remote commit rollback, third-observer convergence, and
concurrent HEAD/ref/index/worktree mutation during snapshot creation.
The packaged live evidence is recorded in the
[Daytona and Cloudflare Git workspace restore UAT](../uat/2026-09-07-workspace-in-place-restore-daytona.md).
