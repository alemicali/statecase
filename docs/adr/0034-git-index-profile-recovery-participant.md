# ADR 0034: Join Git index ownership to the profile checkpoint

Status: internal ConfigStore integration implemented; reference/runtime qualification open
Date: 2026-09-08
Test IDs: RT-006, WS-034, BK-009

## Context and failing-first evidence

ADR-0033's synthetic descriptor coordinator did not preserve a native lock in
the real profile checkpoint. An index outside a linked worktree was also outside
the file journal's authority. Initial tests reproduced both gaps, absent writer
exclusion and overly broad access to sibling Git configuration. Additional failing
tests reproduced caught rollback after native-lock ownership loss, installation
after a backup-boundary ownership loss, and index symlink/deletion admission.

## Decision and authority

The internal `ConfigStore.materializeConfig` options accept selected workspace
roots, not arbitrary Git metadata grants. Each must occur in the exact original
persisted profile as a materialized Git workspace; identity-only, duplicate,
unselected, noncanonical and more than 32 participants are refused.

Resolve each selected root's native `.git` directory or bounded gitfile and its
optional `commondir`. Git documents both [directory and gitfile repository
layouts](https://git-scm.com/docs/gitrepository-layout); shared repository metadata
must not be confused with the worktree-specific index. At admission, require the
system Git `rev-parse` root/Git-directory/common-directory/index paths to agree.
This is a bounded local query with global/system configuration disabled, fsmonitor
disabled, no inherited Git routing/config-injection variables, no credentials,
and fixed recovery-required diagnostics on failure. It does not fetch objects.

Retain directory inode/mode/owner/physical-path observations and stable bounded
single-link, no-follow/nonblocking gitfile/commondir identities and content hashes.
Re-derive this layout from the original selected root on every recovery. Never
accept the descriptor's own paths as grants. Replay does not invoke Git and can
validate these locators while HEAD is absent; this does **not** implement HEAD
replay or grant permission to modify HEAD.

The file journal gets only the exact derived index path, including outside a
linked worktree, alongside its existing exact profile grant. Directory grants
exclude configured `.git` paths and participating Git/common directories. Exact
grants take precedence over those exclusions; sibling config, refs, objects,
credentials, locks and control files gain no authority. Forward index symlink and
deletion requests and pre-existing non-regular/multiply-linked indices are refused.
Index content still comes from the prepared
workspace participant; this coordinator is not an independent Git index parser.

## Durable ordering

1. Under the existing ConfigStore kernel mutex, derive/validate all layouts and
   prepare all private native ownership anchors without publishing native locks.
2. Publish a private version-two profile checkpoint containing every layout and
   lock descriptor before acquiring the first native lock. Version one remains
   the non-Git checkpoint; version two requires a nonempty bounded participant set.
   The reader bound is twice the profile limit plus 2 MiB for participant metadata.
3. Acquire all exact native index locks; validate all participants before starting
   the existing file journal. Publish `applying` before any file/index mutation.
4. Guard complete native ownership through file/index/profile installation,
   durable commit, caught rollback and restart replay. An observational held-lock
   check never reacquires a missing lock. In particular, verify again after the
   backup boundary before installing the prepared file.
5. Use the existing shared file/profile rollback or commit decision. Persist the
   settled profile receipt before removing the file journal.
6. After journal removal and profile/receipt validation, validate **all** remaining
   lock evidence before releasing any lock. Release in reverse order, retaining
   descriptors through each native unlink/anchor removal/directory-fsync boundary.
   Only then retire and fsync the outer checkpoint.

A kill before acquisition cancels the prepared checkpoint without native changes.
A kill while an index/profile is absent replays the file journal while holding the
original native locks. A kill during release repeats release from the retained
outer receipt. Foreign/recreated/lost locks, changed locators and malformed or
missing version-two participants fence the profile and preserve recovery evidence.
Preview performs no lock acquisition/release, journal mutation or directory fsync.

## Alternatives, impact and limitations

Recording descriptors only in a test journal does not integrate recovery.
Granting the whole Git directory admits unrelated native metadata. Retrying lock
acquisition after ownership disappears does not restore exclusive history.
Checking ownership only at forward writes still permits an unsafe caught rollback.
Deleting descriptors before directory-durable release loses interruption evidence.

No cloud schema, dependency, public command, profile framing format, harness patch
or ordinary workspace index-lock helper changes. Older internal checkpoint readers
reject version two. An old version-one journal containing previously unqualified
Git metadata no longer receives broad `.git` authority; it is retained/refused,
not silently migrated. These are unreleased internal recovery records, not a
historical public-profile migration.

This joins **index/file/profile** recovery, not complete Git state recovery.
Normal CLI/daemon/shim reconciliation remains on the existing path until HEAD/ref
intents and replay, retained Git objects/shared-index dependencies, activity
barriers and the prepared-workspace handoff join the same decision. No same-HEAD
restriction is substituted for the requested final product. Full branch/baseline
transitions, reftable/reflog handling, LFS/submodules, native-directory transitions,
profile/control co-location, all syscall/power-loss cases and prepublication
private orphans remain requirements. Layout checks are observational and cannot
provide atomic CAS against arbitrary same-user or above-root filesystem races.

Full prepared-plan integration, mixed clients, cross-host/live-cloud/native UAT,
independent review and all existing release gates remain open. The live Worker,
operator profiles, harness state, credentials and cloud buckets are unchanged.

## Verification

The real ConfigStore is bundled into disposable processes, not a synthetic
replacement coordinator. Actual SIGKILL tests cover checkpoint-before-lock,
native publication, index backup/install, profile installation, durable commit,
file-journal retirement and each native lock-release boundary. Fresh processes
recover exact original index/profile/worktree or retain matched committed state;
timeouts are failures, never evidence of process death. Real `git add` is blocked
while the participant is held and succeeds after completion.

Adversarial tests cover linked worktrees, relative gitfiles, missing HEAD during
locator validation, environment redirection, modified locators, forged grants,
pointer bounds/kinds, malformed Git reports, multiple participants, loss of native
ownership during forward/caught/restart paths, non-mutating preview, omitted
version-two metadata and denied sibling/index-kind requests. Run these suites on
the disposable macOS job as well as Linux quality/runtime jobs. Hosted results
must be recorded for the exact final candidate before claiming that qualification.

The first full local check passed 1,225 tests. After three additional unsafe-index
cases, a second full run passed 1,227 cases but the pre-existing WS-034 return-sync
test exceeded its unchanged five-second timeout (5,074 ms). The focused diagnostic
run passed with 1.86 seconds of test time. This is consistent with concurrent
subprocess pressure, not proof of every timeout's cause. The Vitest worker cap now
reserves half the available parallelism for child processes (minimum one, maximum
four workers), using its documented [worker concurrency setting](https://vitest.dev/config/maxworkers).
No correctness test, timeout or coverage threshold was removed/raised/lowered.
Final complete local and exact-candidate hosted checks remain mandatory; the
earlier failed run is not waived or hidden by an automatic retry.

Final local `npm run check` passed all 1,228 tests in 70 files, lint/types/build
and clean-installed package smoke. Git-index participant branches are 93.75%
(100% lines/functions), profile checkpoint 92.85%, native locks 94.73%, file replay
92.30% and materializer 95.72%. Global branches are 92.81% (5193/5595). Hosted
qualification remains a separate exact-candidate gate.
