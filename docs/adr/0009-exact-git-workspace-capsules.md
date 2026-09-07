# ADR 0009: Exact Git workspace capsules

Status: accepted
Date: 2026-09-06
Owners: Statecase maintainers
Test IDs: WS-010 through WS-018, WS-025, WS-026

## Context

Session files alone cannot make an agent portable. A resumed harness may need
the exact dirty checkout it observed, including content staged in the Git index
that differs from the working file. Synchronizing the `.git` directory would
copy credentials, locks, worktrees, and machine-specific repository state.

## Decision

Statecase records the current commit and symbolic branch as baseline identity,
then captures only paths changed from that baseline. Every record models index
and worktree state independently. Content is stored as encrypted, chunked blobs
identified by Git object ID; deletions and untracked files are explicit. File
modes and safe relative symlinks are preserved. Absolute paths and `.git`
contents never enter the capsule.

Pull requires an existing clean Git working tree. When its baseline differs,
the device-local `ask|auto|never` policy from ADR-0007 governs acquisition.
Auto mode uses system Git and the checkout's existing `origin`, without
serializing a remote or credentials, then checks out the exact baseline and
recreates the authenticated symbolic or detached HEAD identity. The previous
target branch ref is part of transactional rollback state. The
entire capsule, every state transition, mode, path, object ID, blob reference,
size bound, and symlink target is validated before mutation. The original Git
baseline and index are restored if acquisition or filesystem materialization
fails, including failure after an earlier workspace in a multi-workspace pull.
Reapplying an already materialized capsule is a semantic no-op even if JSON
object keys or blob entries arrived in a different canonical order.

Unborn and detached repositories have explicit deterministic representations.
An uninitialized staged gitlink can be reproduced without copying nested
repository bytes. Initialized submodule worktrees fail closed until a separate
transactional submodule hydration design is implemented.

An ordinary pull still requires a clean destination. Explicit in-place
historical replacement is a separate destructive, Git-aware recovery flow: it
preserves HEAD, affected refs, the raw index, and exact worktree paths before
mutation and forks the remote revision forward. See ADR-0018.

Baseline Git LFS pointer blobs are detected with bounded Git plumbing. A
pointer or missing worktree file fails with `GIT_LFS_CONTENT_UNAVAILABLE`
instead of masquerading as restored content. An explicit overlay replacement or
deletion resolves the path. Explicit auto policy invokes the device-local Git
LFS client, cache, existing origin, and credential helpers; Statecase verifies
the pointer's size/SHA-256 and rolls back partial checkout. No LFS credential,
remote, or object-cache directory is synchronized.

## Alternatives considered

- Copy `.git`: rejected because it is unsafe, path-dependent, and includes
  credentials and volatile locks.
- Copy only working files: rejected because it loses staged state and deletions.
- Depend on rename heuristics: rejected; source and destination content states
  are represented explicitly.
- Silently skip unsupported submodules: rejected because the resulting session
  would appear resumable with missing context.

## Consequences

Clean tracked content is obtained from Git and consumes no Statecase storage.
Only non-reproducible work-in-progress bytes are uploaded. A receiver must have
a clean checkout and must either have the baseline commit or permit device-local
system-Git acquisition. Capsules can be larger than session metadata, so
per-file and aggregate bounds are enforced.

## Security and privacy impact

Git credentials and repository databases remain local. Incoming capsule data
is treated as untrusted even after authenticated decryption, preventing path
escape, special-file creation, unsafe symlink targets, invalid index modes, and
object-ID substitution. Initialized nested repositories are never traversed.

## Verification

Tests cover clean baselines; staged/unstaged divergence; additions, deletions,
binary and empty files; executable bits; relative symlinks; detached and unborn
repositories; gitlinks; dirty/baseline conflicts; canonical ordering; malformed
metadata; corrupt bytes; inbound path/symlink attacks; shallow-clone acquisition;
unreachable/redacted origins; symbolic-branch convergence after baseline
acquisition; LFS pointer rejection, local-cache and remote
acquisition, integrity failure, overlay replacement, and rollback; and injected
single- and multi-workspace rollback.
