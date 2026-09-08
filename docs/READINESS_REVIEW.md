# Statecase design readiness review

Status: foreground sync implemented and deployed; release qualification in progress; not ready for public
production launch
Last updated: 2026-09-08

## Decisions now clear

- Product: Statecase. The canonical one-liner is "Take your agents anywhere.
  The encrypted Dropbox for agents: carry sessions, skills, context, and work
  in progress across every machine, so each agent picks up exactly where it
  left off." Operational context—not the model or executable—is the portable
  object.
- Repository: create a standalone Statecase repo/package as a greenfield
  npm-workspaces monorepo with no AgentStash, ClawStash, or Restic dependency.
  Accepted in ADR-0001.
- Initial harnesses: Codex and Claude.
- UX: native harness commands remain normal through transparent shims plus a
  daemon; foreground `statecase run` handles ephemeral systems.
- Data: harness state, workspace capsules, and arbitrary Drops are independent
  synchronized namespaces.
- Workspace continuity: pinned Git baseline plus index/worktree/untracked
  overlay; source hosting itself remains Git.
- Resume integrity: immutable Session Capsules bind a session checkpoint to its
  exact workspace and Drop dependency closure.
- Activity: parse harness/session events and reconcile filesystem/Git; OS-level
  read interception is optional and non-authoritative.
- Identity: logical workspace/drop/session IDs with device-local path mappings.
- Cloud: for the initial release, deploy one remote Cloudflare stack in the existing
  account: one Hono Worker, one R2 bucket, one D1 database, and one Durable
  Objects namespace (with one logical coordinator instance per vault). Local
  development is the only separate environment; there is no remote staging
  stack yet. Accepted in ADR-0002.
- Security: local E2EE, device identity, separately wrapped scope keys, scoped
  single-use bootstrap capability, secrets excluded by default.
- Crypto: libsodium XChaCha20-Poly1305-IETF envelopes, Argon2id recovery-key
  derivation, and keyed scope-local object IDs. Accepted in ADR-0003.
- Auth: Better Auth on Hono/D1 with RFC 8628 device authorization plus
  Statecase-owned scoped bootstrap capabilities. Accepted in ADR-0004.
- Local database: `better-sqlite3` behind a Statecase storage interface.
  Accepted in ADR-0005.
- Chunking: complete-record JSONL, FastCDC-style ordinary files, and fixed
  chunks for compressed/encrypted formats. Accepted in ADR-0006.
- Credentials: system Git with explicit fetch policy; harness, model-provider,
  and Git credentials are never synchronized in v1. Accepted in ADR-0007.
- Sync: local durable journal, incremental chunks, optimistic commits, safe
  merges, preserved conflicts, offline retry.
- Recovery: every sync is a revision; retention and protected snapshots prevent
  propagated deletion from becoming immediate data loss.
- Agent-native behavior: skills invoke stable JSON CLI operations but are not
  the persistence mechanism.
- Delivery: TDD, contract tests, fault injection, paranoid UAT, staged beta.
- Repository security availability: the private repository's current
  GitHub plan does not expose branch protection, CodeQL/code scanning,
  dependency review, secret scanning, or push protection. These controls are a
  mandatory pre-public-release gate, not silently waived.

## Use-case coverage

| Case | Designed | Release evidence required |
| --- | --- | --- |
| First laptop | yes | UAT-01 |
| Additional laptop with different paths | yes | UAT-02 |
| Persistent headless VPS | yes | CLI/daemon integration + UAT-02 |
| Ephemeral sandbox/Daytona | yes | UAT-06/07 |
| Agent-triggered setup/hydration | yes | SK suite + UAT-06 |
| Offline work/reconnect | yes | RT/SY suite + UAT-07 |
| Same and different concurrent sessions | yes | SY suite + UAT-05 |
| Dirty source workspace continuity | yes | WS suite + UAT-02/03 |
| Files read outside repository | yes | WS-021 + UAT-04 |
| Arbitrary folders | yes, as Drops | DR suite + UAT-04 |
| Non-Git project | yes, explicit mirror mode | WS/DR suite before support claim |
| Backup/rollback/deletion recovery | yes | BK suite + UAT-08 |
| Lost/revoked device | yes | AU suite + UAT-09 |
| Isolation from existing backup tools | yes | IS suite + UAT-10 |
| Harness format change | yes, fail closed | adapter suite + UAT-11 |
| Uninstall/bypass | yes | RT-012 + UAT-12 |

## Deliberately unresolved release decisions

These do not block starting implementation, but each blocks the indicated
milestone and must become an ADR:

1. **Supported Codex/Claude version window and fixture acquisition process** —
   blocks compatibility claims.
2. **Native Windows semantics** — deferred; WSL smoke support only for the initial release.
3. **Hosted pricing, data-region, metadata retention, and legal terms** — blocks
   commercial launch, not OSS implementation.
4. **Trademark/domain clearance for Statecase** — blocks brand investment, not
   technical work.
5. **Control-panel decryption UX** — deferred; CLI is the initial control plane.

## Scope completeness verdict

The product scope, initial and steady-state behavior, core trust model,
workspace continuity, arbitrary file synchronization, concurrency, recovery,
automation, schema evolution, and major operating environments are sufficiently clear
to begin TDD implementation.

## Implementation checkpoint — 2026-09-06

The first usable vertical slice is complete: manual first-device and
second-device enrollment, encrypted recovery kit, account-scoped vaults,
client-side encrypted/chunked object transfer, atomic optimistic commits,
Codex/Claude complete-record handling, skill transfer, arbitrary Drops,
logical workspace path rewriting, and exact Git index/worktree overlay transfer.
The single Cloudflare release stack is provisioned and signup allowlisted.

The CLI also packs as a self-contained `@statecase/cli` tarball. Its
runtime manifest contains only the external native SQLite dependency; bundled
workspace code and the canonical agent skill are verified by a clean-prefix
installation smoke test in the normal quality gate.

The next foreground slice is implemented locally: `statecase run` supervises
unmodified Codex/Claude processes with inherited terminal and signals, bounded
preflight and final synchronization, periodic publishing, exact exit-code
preservation, and durable queued retry. Statecase-owned transparent shims are
atomically installed/verified/removed without overwriting unrelated binaries.
Remote deletions now use manifest tombstones, unhydrated namespace pushes fail
closed, and pull materialization rolls back as one transaction after injected
mid-apply failure. This slice is deployed on the definitive Cloudflare resource
names and has passed remote compatibility verification.

The packaged `@statecase/cli@0.1.0` artifact also passed a credential-isolated
Daytona/Cloudflare product UAT with real Codex and Claude binaries, two
independently authorized devices, encrypted binary/UTF-8/hidden-file round
trips, deletion propagation, stale-base conflict detection, protected conflict
resolution, and named snapshots. See the
[executed UAT report](uat/2026-09-06-daytona-cloud.md).

The persistent daemon core is also implemented locally with a single-profile
crash-recoverable lock, recursive filesystem hints, periodic source-of-truth
reconciliation, remote polling, serialized execution, bounded exponential
retry, no-op revision suppression, and owner-only Unix-socket status. Native
systemd-user and launchd installers are implemented with safe ownership and
uninstall semantics. The [native Linux lifecycle UAT](uat/2026-09-08-native-systemd.md)
passed real systemd-user start/stop, private IPC, filesystem notifications,
duplicate-writer denial, and SIGKILL restart with an isolated unauthenticated
profile. The [macOS launchd drill](uat/2026-09-08-native-launchd.md) also passed
on macOS 26.6.2 arm64 with Node 24.20.0, including idempotent CLI start/stop and
profile isolation. Definitions pin the installing Node interpreter.
Sleep/reboot integration and separate-host/native-harness background convergence
are still required before full background steady state is claimed.

The [local authenticated background drill](uat/2026-09-08-background-sync.md)
now exercises two real daemon processes against workerd/D1/R2: bidirectional
transfer without manual sync, an interrupted encrypted upload, durable journal
replay across SIGKILL/offline restart, disjoint writes, deletion, and idle no-op
behavior. The subsequent [packaged native/live drill](uat/2026-09-08-native-cloud-background.md)
passed the same interrupted-upload/replay/convergence sequence with real
systemd automatic restarts against live Cloudflare. Its two device installations
were on one host; separate-host and real harness resume evidence is not implied.

Exact workspace capsules now reproduce staged and unstaged bytes separately,
deletions, additions, modes, safe symlinks, detached and unborn repositories,
and uninitialized gitlinks. They reject malformed/corrupt input and dirty or
mismatched destinations before apply, and roll back both the Git index and
working tree on failure. A per-workspace `ask|auto|never` policy now controls
missing-baseline acquisition through device-local system Git. Auto mode uses
only the checkout's existing `origin`, disables interactive credential prompts,
redacts Git failures, supports shallow clones, and rolls every earlier checkout
back if a later workspace cannot be prepared. Initialized submodule hydration
remains an explicit follow-on gate. The packaged path passed
the
[Daytona Git-baseline acquisition UAT](uat/2026-09-07-git-baseline-daytona.md)
against the live Cloudflare service.

Git LFS pointer detection is now fail-closed on both capture and hydration.
Statecase identifies baseline pointer blobs through Git plumbing, reports the
affected logical paths as `GIT_LFS_CONTENT_UNAVAILABLE`, and accepts a path only
when device-local Git LFS has materialized it or the encrypted overlay replaces
or deletes it. With explicit `auto` policy it now attempts the local LFS cache,
then performs a bounded non-interactive exact-baseline fetch from the existing
origin, and verifies the pointer's declared size and SHA-256. Partial or corrupt
materialization rolls back and raw Git LFS diagnostics remain hidden. Statecase
does not acquire or synchronize LFS credentials. The packaged candidate passed
the [Daytona Git LFS acquisition UAT](uat/2026-09-07-git-lfs-daytona.md) with
system Git LFS 3.6.1 against the live Cloudflare service.

Persistent installations now keep a stable device ID independent of absolute
paths and Better Auth session rotation. D1 binds each service session to that
installation. Device listing and explicit revocation atomically revoke vault
memberships and all bound sessions; attempts to re-register through a revoked
session fail. Post-revocation cryptographic rotation is implemented and deployed:
each rotation creates a fresh root at the next epoch, commits sealed envelopes
for the exact active-device set in one D1 transaction, revokes existing scoped
capabilities, rejects stale writes, and lets active devices ingest contiguous
envelope history. Encrypted version-two recovery kits retain the historical
keyring and reject stale replacement enrollment. Lost mutation responses are
accepted only after the rotating device decrypts and matches its own envelope;
an unprovable outcome preserves the candidate kit. Already-decrypted data and
historical ciphertext copied by a revoked device cannot be remotely withdrawn.
The packaged [live Cloudflare/Daytona rotation UAT](uat/2026-09-08-key-rotation-daytona.md)
passed multi-epoch offline catch-up, revoked device/scoped-session denial,
non-mutating stale enrollment, current-kit recovery, scoped reissuance, and
cross-epoch historical Drop restore. Actual process-reset fault injection and
independent security review remain unqualified.
The [2026-09-08 local key-epoch qualification](uat/2026-09-08-key-epochs-local.md)
records passing offline/restore variants, final coordinator fencing,
transactional capability/enrollment checks, immutable exchange identities,
and injected D1 failure recovery. It explicitly separates this evidence from
live deployment, real process-reset fault injection, and outstanding
release gates. Additional local CLI tests now cover multi-epoch offline
catch-up, unchanged credentials/files on incomplete or forged history, and
lost-response reconciliation after a newer rotation. Download and cleanup
faults verify derived-key release, discarded temporary merged sessions, and
unchanged remote revisions; these complement the packaged live drill.

Full-key devices now merge concurrent appends to the same recognized Codex or
Claude JSONL session when both branches retain one byte-identical complete
base. Canonical record occurrences deduplicate shared events, a deterministic
topological merge preserves each branch order, and malformed, incomplete,
rewritten, or order-incompatible histories fail closed without advancing the
remote head. The merged Session Capsule re-extracts activity from both branches.
The publisher keeps its old applied marker until a verified record-supersequence
pull materializes the result. Scoped capability clients are excluded from this
trusted same-path merge. Unit and in-memory two-device integration evidence is
green. Device-local native session bindings now route the merged result back to
the file each harness already owns, persist through supervised final flush and
hydration, use a canonical fallback on fresh devices, and fail closed on unsafe
or colliding destinations. The packaged four-device Daytona run passed against
the live Cloudflare service, including rejected rewrite, deterministic merge,
dependency retention, native origin-path writeback, and absence of a duplicate
canonical file. See the
[same-session append merge UAT](uat/2026-09-07-session-append-merge-daytona.md).
Session hydration now also resolves harness, workspace, and Drop namespaces
from independently pinned vault checkpoints and applies their authenticated
state in one filesystem/Git transaction. Multi-revision dry-run and a missing
pinned object are verified non-mutating.
Automatic retention now selects deterministic UTC hourly/daily/monthly
checkpoints and runs a daily owner-policy collector. Opaque reachability keeps
the current head, protected snapshots, Session Capsule pins, append parents,
and grace-period uploads. A Durable Object lease excludes concurrent commits;
unknown pre-tracking/legacy history is retained conservatively. Core, Hono, and
real workerd R2/DO tests cover preview, deletion, contention, expiry, and
crash-recovery metadata finalization. Live-service destructive UAT remains.
Bounded-memory push/pull is now implemented for both workspace-bound and
unbound harness JSONL. It stages records securely, hashes incrementally,
encrypts/decrypts one 4 MiB object at a time, installs from a verified staged
file, and skips remote content-addressed chunks during append. Automated
multi-chunk transfer and paranoid integrity cases are green. The literal 2-GiB
acceptance run passed on Daytona with 514 initial objects, bounded two-object
tail uploads, and convergence on both native paths. Concurrent append merge now
validates and copies common history as a stream, retains only bounded branch
suffixes, emits file-backed staging, and verifies the accepting pull record by
record. All new
plaintext staging paths preflight available temporary-disk capacity with a
safety reserve and retain fail-clean semantics if capacity later changes. A
Daytona object-backed temporary mount exposed and now has regression coverage
for an empty temporary root disappearing between sync commands.

Full-key, two-way Drop, stopped Codex/Claude mappings, and Git workspaces now
support explicit in-place historical restore. The flow creates both a protected
cloud snapshot and a persistent local emergency snapshot, excludes
daemon/harness writers, rejects unsafe targets, validates materialized state,
rolls back failed commits, and publishes a new forward revision rather than
rewinding the shared head. Workspace recovery preserves HEAD/ref identity, the
raw index, and affected worktree paths; it handles dirty, detached, unborn, and
missing-baseline repositories while refusing initialized submodules and source
races before mutation. The packaged Drop flow passed a two-device
Daytona run against the live Cloudflare stack, including offline emergency
rollback and complete cleanup; see the
[in-place restore UAT](uat/2026-09-07-in-place-restore-daytona.md).
The packaged Git workspace flow also passed with exact symbolic branch, HEAD,
index, worktree, untracked-file, and symlink recovery; a differently mapped
independent clone converged and the source then rolled back offline to its raw
pre-restore Git state. The drill exposed and fixed detached-HEAD convergence in
ordinary baseline acquisition. See the
[workspace restore UAT](uat/2026-09-07-workspace-in-place-restore-daytona.md).

Full automated background steady state is not yet claimed. Separate-host/native-harness
convergence, sleep/reboot qualification,
real-version harness restore UAT, and real harness-version compatibility remain
blocking work for a public or unattended release.

The design is intentionally not called production-complete. Independent security
review, the exact harness compatibility matrix, and legal/commercial decisions
remain explicit gates rather than hidden assumptions. Any new requirement that
changes trust boundaries, plaintext exposure, conflict semantics, or deletion
must update the strategy, implementation specification, threat model, and test
traceability before code merges.

### Native Codex continuity checkpoint — 2026-09-08

The [native Codex drill](uat/2026-09-08-native-codex-resume.md) passed actual
Codex 0.153.4 `exec resume` by the original UUID after engine-level encrypted
transfer and strict Session Capsule hydration into a different home/checkout.
The target began with an empty native SQLite directory. Its restored model
input included the original prompt and tool outputs, and native tools read and
modified the transferred file in the mapped target while leaving the source
unchanged. Responses came from a deterministic loopback fixture; storage was
an in-memory reference transport inside one Daytona sandbox, not live Cloudflare.

This drill exposed and fixed missing freeform `apply_patch` activity references.
It does not establish that arbitrary shell/code executions disclose all reads:
`exec_command` command strings are not currently parsed or traced. A clean
`strict` report validates the extracted dependency set, not universal read
coverage. Complete coverage reporting for opaque tool execution remains required
before an unconditional complete-context claim. Packaged/live-cloud cross-host
resume, Claude resume, interactive pickers, the full compatibility matrix, and
sleep/reboot remain open qualification work.

An extended native return-sync drill subsequently reproduced a release-blocking
false conflict: a Git-dirty source workspace is rejected even when it still
equals the work already published/applied through Statecase. The target's
continued session and files publish, but normal pull back to the source stops
at `inspectWorkspaceDestination`'s unconditional dirty check. No overwrite or
data loss was observed. A local WS-034 candidate now passes the initial return
regression, preview, new-local-edit/history refusal, index-lock ownership,
selected editor races, and injected materialization rollback. It authenticates
the prior capsule and stages the index separately (ADR-0020). A valid encrypted
substitute revision is rejected if it is not the exact prior revision requested.
The latest complete `npm run check` passed 495 tests with 90.38% global branch
coverage, build, and clean-prefix package smoke. Workspace-package branch
coverage is still 88.85%, below its critical-code target; file materialization
is at 96%. New tests reproduced and fixed rollback clobbering independent Git
branch advances and post-install editor writes. Available original backups are
retained when exact rollback is unsafe and excluded from ordinary sync.
The fresh Daytona native drill now also passed the mapped-CWD return sync
with 67 encrypted objects; it remains a two-home, one-host, reference-backend,
deterministic-provider test of the preceding candidate. The subsequent
branch/rollback hardening requires its own native CI rerun. Persistent
interrupted recovery, atomic HEAD and check-to-mutation races,
managed LFS acquisition, packaged/live cross-host UAT, and broader qualification
remain unresolved. Do not describe ordinary workspace round-trip sync as fully
release-qualified yet.
