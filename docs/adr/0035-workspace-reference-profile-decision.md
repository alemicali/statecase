# ADR 0035: One workspace, Git reference and profile decision

Status: internal integration under qualification; ordinary runtime enablement pending
Date: 2026-09-08
Test IDs: RT-006, WS-034, BK-009

## Context and test-first evidence

The index-only participant cannot recover a branch/baseline transition. The
prepared workspace handoff must include HEAD, target branch, packed references
and native reflogs in the same decision as index, working files and applied
profile state. Tests first reproduced the missing ConfigStore integration,
missing retained commit roots and missing coordinated reflogs. Subsequent
regressions reproduced substituted-descriptor acceptance, invalid UTF-8 packed
metadata acceptance, incorrect Git boolean semantics, and object acquisition
before refusal of dry-run, unselected roots or a stale profile.

## Decision and authority

`ConfigStore.materializeWorkspaceConfig` is the internal composition boundary.
Acquire the existing profile mutex, validate the persisted profile observation
and unchanged mapping/authority fields, then validate selected workspace roots
against that original profile **before** preparation can acquire Git objects.
Keep the mutex through preparation, publication and retirement. This operation
rejects `dryRun` before preparation; recovery preview is a separate non-mutating
operation. It accepts no caller-supplied reference grants or admission callback.

Repository layouts and indices remain derived by ADR-0034. A new reference
participant derives exact files and native locks from those layouts and bounded
original/desired reference plans. Revalidation derives the same authority;
serialized paths cannot grant themselves access. The initial implementation
supports the native files backend and refuses other backends without mutation.
This refusal is a qualification gap, not a permanent same-backend product scope.

Grant only HEAD, the destination branch, packed-refs when required, their native
reflogs and transaction-owned retention refs. Keep unrelated configuration,
objects, sibling refs and credentials excluded from directory grants. Limit to
32 repositories, 256 derived reference locks and 512 total exact file grants;
the generic native-lock API's grant limit is unchanged. Reject ambiguous aliases,
invalid branches, duplicate writes and unexpected old values. Preserve unrelated
packed entries, including peeled continuations, rather than rebuilding the store.

Bound reads, require regular single-link files, use no-follow/nonblocking opens,
check descriptor and named-file BigInt identities before/after reading, and
recheck content fingerprints. Decode rewritten control text with fatal UTF-8;
preserve pre-existing reflog bytes exactly. Ask native Git to parse its boolean
reflog configuration, including empty, valueless and numeric values. Append a
fixed Statecase service identity rather than borrowing operator identity. These
local Git queries discard inherited Git routing and global/system configuration.

## Durable ordering

1. Prepare index, worktree, native reference/reflog writes and private ownership
   anchors without advancing operational refs. The version-three checkpoint
   persists all participants before any native lock publication.
2. Acquire index, HEAD, old/target branch, packed-ref, collector and pin locks.
   Validate every participant and run the whole-workspace admission guard under
   those locks, **before** the file materializer stages its sibling artifacts.
3. Use one file journal: retained commit refs first, ordinary worktree/index and
   native reference/reflog writes next, deletions and profile metadata last.
   After pins exist, verify their exact content and commit presence before any
   operational target. Do not recapture the whole worktree after staging: its
   reserved transaction directories would be mistaken for foreign changes.
   Keep immediate per-target source guards, repeated after persisted intent,
   plus native ownership checks for forward mutation and every rollback step.
4. Persist commit or rollback and the paired outer receipt before forgetting the
   file journal. Copy installed pin fingerprints from the **durable plan**, never
   derive ownership from a file observed after installation.
5. Preflight all retention pins, remove only matching owned pins, replay parent
   directory durability, then release native locks in reverse order. Retain the
   outer checkpoint until this completes. Missing pins after interrupted cleanup
   are idempotent; substituted pins or lost native ownership retain evidence and
   refuse recovery. No PID expiry, lock stealing or automatic force recovery.

Git documents [repository reference and common-directory layout](https://git-scm.com/docs/gitrepository-layout)
and [native reference/reflog operations](https://git-scm.com/docs/git-update-ref).
Retention refs name old, desired and overwritten destination commits, deduplicated
per common directory. Refuse an already present `gc.pid`, and hold `gc.pid.lock`
through the decision. In the reviewed [Git 2.43 collector implementation](https://github.com/git/git/blob/v2.43.0/builtin/gc.c),
collector admission locks that path before publishing the running marker, even
for forced GC. A real fixture `git gc --prune=now` is excluded during mutation.
This does not prove exclusion of arbitrary `prune`/maintenance commands or all
Git versions, nor retention of every staged/shared-index dependency.

## Alternatives, consequences and open requirements

Writing refs before the file callback leaves unjournaled native mutation.
Updating the profile in a later independent save leaves applied state torn.
Native multi-ref transactions alone do not include working files or the profile.
Unconditional ref deletion, reflog regeneration or adopting observed pin bytes
as ownership would lose unrelated history or remove a foreign file.

This is a recoverable multi-file decision, **not** an atomic snapshot for
uncooperating readers. Normal CLI, daemon, shim and restore paths are not switched
to this API until their applied/binding proposals and activity barriers join it.
Full closure/shared-index retention, reftable, LFS/submodule and directory
transitions, multi-root concurrency, all syscall/power-loss faults, prepublication
orphan/empty-parent cleanup and arbitrary same-user/ancestor races remain open.
Configuration policy changes during preparation need qualification too.

No cloud schema, dependency, released command, native harness patch or live
deployment changes. Older internal checkpoint readers reject version three;
never downgrade while a checkpoint is pending or rewrite its version to bypass
recovery. These are unreleased internal records, not a public format migration.
Independent review, exact-candidate Linux/macOS evidence and the full cross-host
packaged/live-cloud release gates remain required.

## Verification

`workspace-profile-recovery.test.ts` bundles the real ConfigStore/workspace
implementation into disposable children. Require actual SIGKILL (never a timeout
as evidence), then recover in a fresh process. Compare complete capsules and
exact profile/index/HEAD/reflog bytes as appropriate. Exercise branch, packed,
detached, unborn and linked-worktree states, native ref/log installation, pin
installation/removal, each native lock release boundary, non-mutating preview,
foreign pin preservation and source edits before/after staging.

`git-reference-participant.test.ts` checks separately derived grants, tampering,
bounded stable descriptor reads, native reflog settings and buffer disposal.
The exact grant boundary remains in `materialization-recovery.test.ts`. Full
check/coverage results and unresolved gates are recorded in the readiness review;
passing focused tests alone is not product or release qualification.
