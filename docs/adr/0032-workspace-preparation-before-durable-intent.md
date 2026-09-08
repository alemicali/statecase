# ADR 0032: Prepare Git participants before durable intent

Status: internal preparation handoff implemented; durable Git mutation/replay pending
Date: 2026-09-08
Test IDs: RT-006, WS-015, WS-034, BK-009

## Context and failing-first evidence

ADR-0031 cannot safely be enabled by replacing the last file-materializer callback
in the workspace engine. Both ordinary baseline acquisition and managed updates
can modify native Git state before that callback. The outer coordinator must
first know the complete file/index and reference transition, persist that intent,
and only then admit native mutations.

Eight initial failing tests specified an absent preparation API and an actual
SIGKILL handoff. Boundary tests subsequently reproduced premature consumer
admission with duplicate file targets or an existing index writer, and managed
preflight attempted to inspect a target tree before the missing baseline existed.
Forced-fetch-fallback tests failed for full and shallow clones whose configured
refspec targets local branches. These are regression evidence, not waived cases.

## Decision

Add internal `withPreparedWorkspaceTransaction(applications, initial, consume)`
in the workspace package. Reuse managed content/index staging for clean and
authenticated managed destinations, including a changed baseline. The awaited
consumer receives:

- ordinary/native file writes, links and deletions plus the separately prepared
  worktree-specific index, with the existing immediate per-target guard;
- local-only root and index paths, original HEAD commit/branch identity, desired
  HEAD identity and the original value/absence of the destination branch;
- a repeatable observational guard checking current capsule, exact original
  index fingerprint and destination reference.

No native HEAD, branch, index or worktree mutation occurs in this preparation
handoff. It creates private temporary index staging and may acquire approved Git
objects. Staging is scoped to the awaited consumer. Unlike ordinary application,
it acquires no native index lock before durable admission: a kill at handoff must
not strand an unjournaled writer lock. It observes existing locks and refuses
them without removal. The future coordinator must acquire native writer exclusion
and revalidate before applying; observational guards do not grant exclusive access.
Writer presence is checked before handoff, not in that repeatable source guard,
so the consumer can revalidate sources after acquiring its own native index lock.

Validate all roots before acquisition, reject duplicate roots and final targets,
retain explicit `ask|auto|never` policy and authenticate managed current capsules
through the existing caller contract. Revalidate index bytes from before staging,
not an observation silently refreshed after staging. Ref aliases and unexpected
Git observation errors are not interchangeable with an absent direct branch.
Detached, unborn, existing/packed branch, multi-root and linked-worktree index
paths are represented without copying the repository database into cloud storage.

When a baseline is missing, preflight can inspect current-index and explicit
capsule gitlinks only; after acquisition the complete target tree is inspected
again before handoff or mutation. Initialized submodules remain refused.

## Object acquisition before intent

The preparation-specific fetch path suppresses `FETCH_HEAD`, tags and implicit
ref mappings. It first requests the exact commit. On a server refusing that
request, enumerate advertised branch sources and fetch them in batches of 64
without destination refspecs or configured ref mappings, unshallowing when needed.
Stop once the requested commit exists. Git output and command timeouts retain
existing bounds. Invalid/empty/unavailable advertisements or failed acquisition
refuse handoff. Object-pack/shallow-cache changes are permitted preparation, not
operational HEAD/index/worktree changes. This is not a network-free preview API.

Ordinary application retains its existing acquisition path. The new handoff is
not yet called by normal sync, daemon, shim or restore workflows.

## Alternatives and integration requirements

- Enabling file/profile replay at the old callback would journal Git too late.
- Checking Git once before a long preparation misses later independent edits.
- Reusing the ordinary fetch fallback can advance local refs via user refspecs.
- Holding an unjournaled index lock during preparation strands it after SIGKILL.

Git's [reference transaction interface](https://git-scm.com/docs/git-update-ref)
provides expected-old-value checks and explicit prepare/commit operations; it
does not by itself make Git, native files and the Statecase profile one durable
transaction. The persistent Git participant, repository identity/authority,
owned native-lock recovery, object retention, per-transition intents, restart
CAS/HEAD recovery and the shared commit/rollback decision still need implementation.
The prepared reference descriptions alone are not restart authority.

This adds no runtime dependency, cloud schema, profile format, native harness
patch or public command. Absolute paths stay device-local. Existing normal
materialization retains its prior recovery limitations; do not advertise this
as Git crash recovery or enable the new file/profile coordinator prematurely.
Power loss, all Git syscall boundaries, pre-publication orphan staging cleanup,
directory transitions, LFS acquisition into staging, initialized submodules,
native activity barriers, mixed clients, cross-host UAT and security review remain
requirements, not excluded product scope.

## Verification

The synthetic suite bundles the actual workspace module into a child, kills it
at prepared handoff and compares exact original index bytes, HEAD/branch and
worktree files while proving no native index lock remains. It exercises the
prepared index independently with system Git, distinct staged/worktree bytes,
multi-root and ordinary-file composition, guard refusal after independent changes,
linked worktrees, packed refs, detached/unborn states, active writer and duplicate
denial, policy refusal and full/shallow/multi-batch object-only fallback.
Read-only Git fault proxies supply invalid/error observations and acquisition
failures. The real-process proxy cases use an explicit 30-second test timeout;
the first full coverage run exposed the unsuitable default five-second timeout.
Subsequent process proxies were changed to shell `exec` passthroughs, avoiding
another Node VM for every ordinary Git observation; overloaded concurrent runs
also exposed pre-existing five-second integration timeouts. Their timeouts were
not raised and those failures remain part of the local verification history.
No retry or skipped final check substitutes for a passing full run.

Final local evidence: complete `npm run check` passed 1,104 tests in 67 files,
lint/types/build and clean-installed package smoke; a second full coverage run
passed the same 1,104 tests. Of V8 branches starting on added source lines,
45/46 were covered (97.82%). Whole-workspace coverage remains 89.67%, below its
module-wide target; the full release qualification is not closed by this slice.
