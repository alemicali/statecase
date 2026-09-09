# ADR 0036: Couple engine materialization to its observed profile

Status: internal engine integration under qualification; command/runtime enablement pending
Date: 2026-09-09
Test IDs: RT-006, WS-034, SY-011, SY-012, AD-MEM-005

## Context and failing-first evidence

ADR-0035's complete coordinator is insufficient if SyncEngine still mutates Git
before invoking a final file callback or records applied state in a later save.
The first failing tests required the encrypted engine pull to call the real
ConfigStore with its complete proposal and leave both disk and memory unchanged
after a caught rollback. A subsequent failing hydration test showed that its
scoped content-selection clone is not the original observed profile: it drops
unrelated mappings/applied markers and changes selected mappings to consume mode.
That clone must never become authority to replace the persisted profile.

## Decision

Add the internal `SyncEngineOptions.commitMaterialization` composition callback.
Before publishing native files, calculate the complete applied-revision/digest/
key-epoch and session-binding proposal from verified incoming manifests. Preserve
the previous marker maps, skip incomplete namespaces as before, and validate
session destinations while constructing the proposal rather than after writes.

Pass the original observed profile object, complete workspace applications and
guarded native file transaction to the coordinator. ConfigStore then stages and
applies them using ADR-0035; the ordinary workspace materializer must not run
before this handoff. Preserve settings, instruction, memory, file-content and
prepared-workspace source guards, including their immediate pre-mutation repeat.

Temporarily expose only the proposed applied/binding fields on the same object
whose persisted observation ConfigStore recorded. Do not clone away its stale-
write protection. If the coordinator rejects, restore the exact original marker
map references and preserve an originally absent bindings property. ConfigStore
invalidates its observation after an attempted failed materialization; restoring
the JavaScript fields cannot turn a stale proposal into save authority. A durable
commit remains the disk authority if the process dies before the call returns.

For session hydration, bind each narrowed content view to the original profile
using a per-engine WeakMap scoped by try/finally to that operation. Content
selection and pinned-revision resolution still use the narrow view. The final
proposal starts from the original profile and changes only selected complete
namespace markers and selected materialized/deleted session bindings. Preserve
unrelated mappings, modes, namespaces, memories and bindings. Remove the binding
on success or error. This is local object identity, not an authentication token
or a cross-process lock; ConfigStore revalidates persisted authority under its
kernel-backed mutex.

Dry-run returns before constructing/publishing a durable proposal or invoking
the callback. Explicit historical in-place restore retains its separate emergency
snapshot and remote-publication lifecycle; its explicit materializer takes
precedence and must not accidentally checkpoint a temporary restore profile.
Its integration into a single recoverable remote/local operation remains open.

## Alternatives and consequences

Saving applied state after materialization permits a crash to leave the previous
marker beside new files. Passing only the final file callback journals Git too
late. Passing a narrowed hydration config loses both persisted authority and
unrelated state. Silently accepting a cloned config in ConfigStore would weaken
its stale-profile protection. Re-capturing current local edits is not a substitute
for the authenticated last-applied workspace capsule.

The callback is currently selected by integration tests, not by foreground CLI,
daemon, supervisor or transparent shim wiring. Their native activity barriers,
explicit pending-recovery workflow, upload/no-op marker publication and mixed
writer qualification must join the same design before enablement. Full retained
Git dependency closure, other Git backends and all previous fault/release gates
remain required. No public CLI flag, dependency, cloud schema, live deployment,
credential access or native harness patch is introduced here.

## Verification and rollout

`sync.test.ts` couples real ConfigStore to encrypted engine pull and hydration:
commit, caught rollback, dry-run, changed branch, staged/worktree distinction,
session binding publication and preservation of unrelated profile/Drop state.
The previous entire engine suite must remain green, including historical restore.

`engine-profile-recovery.test.mjs` bundles the real engine/client/crypto/store and
the existing test-only reference transport into isolated child processes. It
publishes encrypted session, Drop and changed-branch workspace state, then
requires actual SIGKILL after session, worktree, HEAD or profile installation,
after durable commit, or during pin retirement. Recovery runs in another process
without the original backend/key in memory. Compare exact old profile/index or
the committed proposal and complete capsule; preserve unrelated local files and
prove Git can write after retirement. A plaintext canary must not reach reference
object storage. A timeout is failure, never proof of the requested boundary.

These tests use no native harness executable, real account, operator profile or
cloud bucket. They do not replace latest packaged independent-host live-cloud
Codex/Claude and daemon UAT. Require Linux and disposable macOS evidence for the
exact candidate, full checks/critical coverage and independent review. Keep all
implementation and qualification in the existing PR7; no merge/release/cutover
until the full readiness review is satisfied.
