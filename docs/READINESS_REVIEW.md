# Statecase design readiness review

Status: foreground sync implemented and deployed; release qualification in progress; not ready for public
production launch
Last updated: 2026-09-08

## Required client/service contract checkpoint — 2026-09-08

The previous committed candidate `5907829` passed all nine jobs in CI
`34218349868`. PR-014 now adds explicit contract/capability negotiation rather
than inferring compatibility from transport generation 1.1. Missing/unsupported
clients are refused before protected domain work or bootstrap consumption;
browser auth stays available. The CLI performs a bounded credential-free public
handshake, shares successful negotiation per instance and invalidates on HTTP
426. A failing-first disconnected-stream test corrected network errors wrongly
reported as incompatibility. CLI JSON compatibility failures use exit 6.

The initial complete local check passes 920 tests in 62 files, lint, types, build and
clean-installed package checks. Global branches are 92.60% (4533/4895); the new
protocol compatibility module and HTTP client are both 100% (16/16 and 43/43).
The separate 12-test workerd suite preserves D1 bootstrap grants on refusal,
then redeems once, and rejects device/capability object/commit requests without
R2/head changes. Hono tests inventory all protected routes before domain calls.
The packaged agent skill was narrowly updated with skill-creator and validated.
The background drill also passed automatic bidirectional transfer, interrupted
upload/journal replay, offline crash recovery, disjoint convergence, deletion
and idle no-op with cleanup verified. This uses two synthetic authenticated
daemons on one host and local workerd/D1/R2, not independent hosts or native
harnesses. A subsequent real-loopback failing test reproduced API redirects
forwarding a synthetic bootstrap body; the client now refuses all API redirects.
The final local check with redirect refusal passes 921 tests in 62 files,
lint/types/build and clean-package smoke; coverage totals above are unchanged.
Exact-candidate hosted CI is still required for this follow-up.

Candidate `4b7d93eb2925b32b4c805ff0f402417a92bf0646` subsequently passed all
nine jobs of [CI 34221032462](https://github.com/alemicali/statecase/actions/runs/34221032462).
Native Codex job `102043932379` retains the original UUID, selected-memory patch
history, both concurrent native contributions and both no-op peers (78 encrypted
objects). Claude job `102043932226` passes ordinary continuity and the seven-fresh-
session memory drill, including same-UUID relative-history resume/return. Both
use pinned harnesses, deterministic loopback inference and reference storage on
one disposable host. Background job `102043932116` passes all transfer/replay/
offline/convergence/deletion/no-op phases on local workerd with cleanup verified.
These exact-candidate passes include redirect refusal; no live service changed.

ADR-0027 explicitly requires a coordinated matched-pair CLI/Worker cutover.
The live Worker is unchanged and lacks this contract: the new CLI refuses it.
This is not local offline old-binary fencing, full historical/profile migration,
safe mixed-Worker rollout, unsupported-Worker rollback or complete native-format
qualification. Those and independent-host/live-cloud UAT remain release gates.

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

## Native preferences and mutex checkpoint — 2026-09-08

CI `34195140316` exposed two issues: suspended mutex ownership could be lost
to native GC, and the Codex fixture confused first-use project-trust creation
with a sync mutation. Explicit mutex rooting now passes forced-GC/SIGKILL
regressions; fixture trust is prepared device-locally before transfer, retaining
byte-preservation checks. On `239a21b`, both pinned native harness jobs in
CI `34196810044` pass fresh-session model/effort, CLI override, native resume
and workspace-return assertions. The local check passes 671 tests. See the
[bounded qualification report](uat/2026-09-08-native-effective-preferences.md).
This is not whole-allowlist, cross-host/live-cloud, memory or release readiness.

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
resume, interactive pickers, the full compatibility matrix, and
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
The latest complete `npm run check` passed 500 tests with 90.39% global branch
coverage, build, and clean-prefix package smoke. Workspace-package branch
coverage is still 88.88%, below its critical-code target; file materialization
is at 96%. New tests reproduced and fixed rollback clobbering independent Git
branch advances and post-install editor writes. Available original backups are
retained when exact rollback is unsafe and excluded from ordinary sync.
The fresh Daytona native drill now also passed the mapped-CWD return sync
with 67 encrypted objects; it remains a two-home, one-host, reference-backend,
deterministic-provider test of the preceding candidate. The branch/rollback
candidate `a92a244` subsequently passed the complete
[CI run](https://github.com/alemicali/statecase/actions/runs/34182284800), including
native Codex return-sync and background synchronization. A later reserved-path
guard passed its own [complete CI run](https://github.com/alemicali/statecase/actions/runs/34182534166),
including native Codex return-sync. Persistent
interrupted recovery, atomic HEAD and check-to-mutation races,
managed LFS acquisition, packaged/live cross-host UAT, and broader qualification
remain unresolved. Do not describe ordinary workspace round-trip sync as fully
release-qualified yet.

The subsequent artifact case-variant follow-up reproduced and fixed uppercase
Drop backup publication and upper/mixed-case workspace artifact destinations,
including parent components. It has the 500-test local check above; its CI must
qualify that specific candidate independently. Unicode/filesystem alias and
crash-recovery gates are not waived by this narrow refusal test.

### Native Claude continuity checkpoint — 2026-09-08

The [native Claude drill](uat/2026-09-08-native-claude-resume.md) passed with
Claude Code 2.1.263 in a dedicated Daytona sandbox. Real Read/Edit/Write tools
read tracked input, edit a tracked artifact, and create an untracked note.
Strict engine hydration transfers the session and overlay onto the identical
Git baseline in a fresh home and differently mapped project; `--resume` reopens
the same UUID with original history, and native target edits synchronize back.
The storage backend is an in-memory reference implementation and model replies
come from a deterministic loopback Messages fixture. This is not packaged CLI
enrollment, live Cloudflare, hosted inference, or physical cross-host evidence.
The first provider runs failed closed on a native HEAD health probe; recognizing
that exact probe allowed the drill to finish without changes to product code.
A dedicated pinned-harness CI job now repeats this scope. Interactive listing,
pre-apply runtime compatibility checks, other harness versions, and the combined
packaged/live-cloud cross-host path remain release gates.

### Packaged Claude/live-cloud checkpoint — 2026-09-08

The [cross-peer foreground drill](uat/2026-09-08-cloud-native-claude.md) now passes
on the package built from `8f33128`: independently authorized installations in
two Daytona instances, real transparent Claude shims, live Cloudflare storage,
strict non-mutating preview and hydration, original UUID/prompt/tool history,
native Read/Edit/Write, final-flush publication, and source file/history return.
The model provider is deterministic loopback; underlying physical host placement
is not asserted. This closes that recorded Claude foreground topology's missing
evidence, not Codex parity, daemon/sleep/reboot, interactive listing, complete
read observation, or full product UAT. All fixture R2/account/sandbox and local
credential cleanup was verified; opaque DO metadata was not explicitly purged.

The drill also exposed a real installer mismatch: `CLAUDE_CONFIG_DIR` affected
the adapter but not default skill placement. A separate correction now resolves
install/verify/uninstall through the same adapter. Failing-first root tests,
isolated-HOME lifecycle, and clean-prefix package setup/verify/uninstall pass;
the complete check reports 503 tests and 90.39% global branches. CI run
`34185025156` passed commit `e908cd0`. That later fix was not in the live tarball
above and still requires fresh combined live qualification.

### Implementation gaps confirmed by source audit

Release work includes missing implementation, not only additional testing:

- ADR-0021 reconciles ADR-0004 native persistence with the later specification's
  permitted owner-only file mode. An explicit Linux Secret Service migration
  is now implemented in `ConfigStore` and the CLI, preserving file-mode/headless
  profiles. Local tests and an isolated native/package drill cover encrypted
  update/logout, unavailable keys and keyring process restart. This is not
  complete platform qualification: default-keychain UI, OS reboot/unlock,
  recovery/downgrade, orphan handling and independent review remain gates.
- ADR-0023 now implements filtered user preferences for Codex and Claude,
  per-field synchronization, guarded native patching and historical recovery.
  Raw `config-filtered` files remain excluded; only reviewed fields enter the
  encrypted namespace. The wider configuration/memory scope is still missing:
  instruction files, project memories, additional profile/role/model documents,
  native compatibility and effective-value checks, cross-host qualification and
  mixed-client fencing. Session continuity does not establish config parity.

Neither gap is waived by successful round-trip UAT or overall coverage.

The [portable-settings local qualification](uat/2026-09-08-portable-settings-local.md)
records 663 passing tests, clean package startup, parser license checks,
per-field encrypted two-device convergence, local-secret preservation and
cross-epoch historical rollback. It does not qualify effective native settings,
cross-host/live-cloud use, mixed-client fencing or memory portability.

### Profile exclusion and crash checkpoint — 2026-09-08

CI `34186898197` passed commit `064ad2a`, including the isolated packaged native
credential job and existing Linux/Node22/Node24/macOS/native-harness jobs.

A subsequent failing-first audit reproduced two owners during stale-lock
reclamation. ADR-0022 adds a dedicated SQLite/kernel mutex, atomic v2 owner
metadata, legacy-live-owner refusal and reserved local guard files. Real-process
tests now prove one winner among eight simultaneous restart contenders after
SIGKILL and recovery from pre-reclaim/pre-publication crashes. That is progress
on local crash exclusion, not proof of workspace rollback, OS reboot, complete
background/native parity or full production readiness. The complete check now
passes 556 tests (90.55% global branches; runtime 95.45%, mutex 95.65%), and the
clean-installed native credential drill passes with the new lock implementation.
The local authenticated two-daemon/workerd drill also passes bidirectional
transfer, interrupted-upload replay, offline crash recovery, disjoint writes,
deletion and idle no-op. See the [recorded evidence](uat/2026-09-08-profile-mutex.md).
Exact-candidate platform CI and remaining broader release gates still apply.

CI `34188250327` on `e05a4e9` passed quality, Node 22/24, background sync,
native credential packaging and the native macOS lifecycle. It failed the
Codex/Claude native jobs during temporary-driver startup. A new failing-first
load test reproduced the missing external SQLite module; the test-only builder
now resolves that installed dependency explicitly outside the repository.
Follow-up CI `34188511917` on `a942d6e` passed all eight jobs, including both
native harnesses. This verifies the correction without retroactively turning
the earlier failed run green. The macOS job here qualifies launchd, not Keychain.

### macOS credential implementation — 2026-09-08

The local credential adapter now supports macOS Keychain, preserves Linux
protected-file compatibility, rejects foreign backends before native access,
and authenticates backend identity. Failing-first tests cover native command
construction, bounded stdin/output, explicit-path isolation, update and failure
semantics. CI `34189667851` on `ad0dec8` passed all nine jobs, including the new
clean-package native macOS keychain drill and verified fixture cleanup. See the
[recorded credential evidence](uat/2026-09-08-macos-credentials.md).
A subsequent launchd-selection fix now pins the chosen keychain path for the
background service. It passes the local 574-test check (90.66% global branches)
and all nine jobs in CI `34189968387` on `e23475c`, including the manager's
effective selected-keychain environment. These checks do not close default-keychain
UI/reboot, harness configuration, workspace crash recovery or wider release gates.

### Global instruction checkpoint — 2026-09-08

Global instruction transport and server-attested write authority are under
qualification (ADR-0024). The local check passed 722 tests across
52 files, 91.48% global branch coverage and clean-installed package checks;
new instruction scan/plan code reached 95.89% branches, descriptor code 96.36%
and instruction policy 96.87%. The separate workerd suite passed 12 tests,
including scoped replace denial and immutable commit provenance. Tests include
concurrent absence/tree guards and historical instruction recovery;
the exact committed candidate still requires native CI evidence.

Native instruction fixtures now require fresh-session global context, Codex
override precedence and Claude imports/rules. Both pinned native jobs pass on
`5dbecea` in CI `34201242162`, which completed with all nine jobs successful;
see the [exact evidence](uat/2026-09-08-global-instructions.md).
The live Worker has not been updated by this change; instruction
publication intentionally refuses a server without the new provenance feature.
Project memory, full native precedence/import/version coverage, mixed-client
fencing, packaged independent-host UAT and all existing release gates remain
open. This checkpoint does not claim production readiness.

### Follow-up CI and memory foundation — 2026-09-08

CI `34201611557` on `db67125` finished with eight successful jobs and a failed
background-sync job. Both native instruction jobs still passed. Background UAT
passed startup, bidirectional transfer, interrupted-upload journal retention
and offline-crash/disjoint convergence, then received ECONNREFUSED from its
local Worker during the idle phase. The earlier all-nine success on `5dbecea`
does not make this later run green. The original fixture discarded process
diagnostics, so server/supervisor cause is not established.

A local repeat of the original drill passed with synthetic workerd/D1/R2 and
verified fixture cleanup. That does not waive the CI failure. RT-017 adds bounded,
redacted process/exit/signal diagnostics and preserves failure without retry or
backend restart; follow-up execution and cause resolution remain required.

ADR-0025 and initial memory binding/Markdown validators are implemented and
unit-tested, not connected product functionality. CLI enrollment, authenticated
collection descriptors, encrypted transport, capsule pins/retention, native
effective location/recall, daemon parity and independent-host UAT remain open.
Ordinary harness setup still does not select or scan memory.

The complete local check for these foundations/diagnostics passed 752 tests
across 55 files, build, type/lint and clean-installed package checks; global
branches are 91.61% (4001/4367). The new memory binding and Markdown policy
modules each have 100% branch coverage (46/46 and 21/21). Both the original
background drill and its instrumented follow-up passed locally with verified
cleanup. Exact-candidate CI is still required; these passes do not establish
why the earlier hosted-runner service disappeared.

Follow-up CI `34203126879` on `e2a8ceb` completed successfully in all nine jobs,
including background synchronization. This verifies that candidate, not the
cause of the preceding service loss; root-cause resolution remains open.

### Memory engine and checkpoint integration — 2026-09-08

Memory collections now participate in encrypted engine push/pull through their
own scope keys, bounded native Markdown policy and authenticated canonical
category/harness/workspace descriptors. Internal descriptors are never written
as native files. Tests cover different device paths, preview, no-op/edit/delete,
conflicts, ungranted-key and read-only denial, scoped append updates, malformed
remote metadata, changed/disappearing files/trees and scanner resource bounds.

Session Capsules pin selected memory checkpoints and expose structured memory
references plus descriptor completeness. Hydration combines independent pins
and filters unrelated configured collections before validation/materialization.
Missing mappings/namespaces/objects and wrong project ownership preserve local
state. Explicit selection changes refresh a capsule without transcript changes;
memory-only updates preserve the unchanged session's historical context. Pins
also enter the existing opaque retention root contract.

Historical memory restore tests cover key epochs 1 and 2, physical-file-only
emergency capture, failed publication rollback, successful restoration/deletion
and post-restore no-op. A failing-first regression fixed generic-restore policy
marker stripping; another fixed descriptor digest bookkeeping after restore.

This is engine integration, not complete native memory portability. CLI memory
enrollment/rebind/removal, native recall/generation and effective root discovery,
custom/subagent coverage, localization of memory references in native history,
daemon watches, mixed-client fencing, live capability/GC drills and packaged
independent-host UAT remain open. No operator native state or live cloud resources
were accessed by these local tests. Exact-candidate CI remains required.

The complete local `npm run check` passes 788 tests across 56 files, lint,
type checking, build and clean-installed package smoke. Global branch coverage
is 91.83% (4171/4542); the new memory scanner/planner is 96.42% and the shared
native-text planner is 96.87%. The separate local workerd suite passes 12 tests
(including its deliberate ambiguous-rotation fault); no live deployment changed.

### Memory CLI, service roots and configuration concurrency — 2026-09-08

CI `34206344550` on `39fa0f7` completed with six successful jobs (including both
native harnesses, native credential/service jobs and background synchronization)
and three failed unit-test jobs. The same unsafe-directory fixture failed under
both Node versions and quality: creation requested 0777 but the runner's umask
removed write permissions, so the resulting directory was legitimately safe.
The failure was reproduced locally under umask 022. The fixture now applies
explicit chmod before exercising the unchanged safety guard; a fresh complete
CI result is still required, and this does not resolve the earlier unrelated
background-service disappearance.

Memory map/list/rebind/remove is now available through the CLI and its packaged
skill, with metadata/count-only previews, explicit confirmation, immutable
logical ownership and no native-file movement/deletion. Staging restore and
conflict selection recognize memory mapping IDs and exclude unrelated memory.
Configuration saves validate inverse ownership collisions and use a kernel
mutex with observed-state comparison; stale CLI/daemon writes fail instead of
losing bindings or applied revisions. This does not make configuration/remote/
credential mutations one atomic transaction or fence older clients.

Selected memory roots participate in daemon filesystem notifications and service
write permissions. A running service must be stopped and reinstalled after root
changes. The new local and clean-package tests do not prove native memory recall,
custom/subagent format coverage, missing-root service startup, hot service reload,
sleep/reboot or independent-host/live-cloud behavior. These remain release work.

The local check with explicit umask 022 passes 798 tests in 57 files, lint,
type checking, build and the expanded clean-installed package smoke. Global
branches are 91.90% (4222/4594); memory management is 100% (44/44), and config
persistence is 94.11% (16/17). The packaged skill was updated using skill-creator
and its validator passed. This local result requires exact-candidate CI evidence.

Follow-up CI `34208471408` on `32fb75b` completed successfully in all nine jobs.
This closes the candidate's umask-fixture recheck, not native memory qualification
or the unrelated earlier background-service root cause.

### Native memory qualification fixture — 2026-09-08

AD-MEM-008 now has an executable Claude 2.1.263 drill, selected with
`npm run uat:native-claude -- --memory` in the disposable GitHub runner. It uses
four fresh session IDs, a repository-derived source memory root and a different
explicit target `autoMemoryDirectory`, synthetic Markdown, deterministic native
Read/Edit/Write calls, encrypted reference transport, strict hydration preview,
return transfer and a disabled-memory negative control. Startup assertions
exclude assistant history, tool results, tool descriptions and prompt canaries;
topic content must be absent at startup and present after the native Read.
Unselected project memory must remain unchanged and absent from startup context.

The fixture is implemented, not yet recorded as a native pass. Its five local
evidence-guard tests pass; the complete local check passes 803 tests in 58 files,
lint, type checking, build and clean-package smoke, with unchanged 91.90% global
branch coverage. Exact-candidate native CI is required. Even a pass here is
two homes on one host with reference storage, not packaged live-cloud parity,
autonomous hosted-model memory generation, worktree/full settings precedence,
subagent formats, memory tool-history localization or Codex memory qualification.

The native-claude job `102007136705` in CI `34209586836` on `cd73673` subsequently
passed, including the explicit four-session memory step. Its redacted pass
record confirms default/custom-root fresh recall, native topic Read/Edit and
index Write, strict non-mutating preview, exact transfer/return bytes, preserved
local settings and the disabled-memory/unselected-project controls. See
[the executed report](uat/2026-09-08-native-claude-memory.md). An extension adds
worktree, subdirectory and actual unrelated-project startup cases; those cases
require a new native run and are not covered by the first pass.
The entire `34209586836` run also completed successfully in all nine jobs.

The expanded native-claude job `102008351039` in CI `34209964941` on `66f4e1f`
then passed with seven fresh session IDs. Worktree and subdirectory sessions load
the original repository index; a separate repository loads only its own index.
The earlier encrypted round trip, native tools, preview and negative controls
also pass again. This qualifies selected native location behavior, not Statecase
worktree capsule transfer, automatic effective-root discovery or full settings
precedence. The report records the exact versions and topology; wider production
and Codex memory gates remain open.
The complete `34209964941` run then finished successfully in all nine jobs.

The documentation follow-up `8dc7b47` also passed CI `34210288919`.

### Typed memory references and same-session qualification — 2026-09-08

A failing-first regression confirmed that restored memory tool inputs still
contained the source machine's absolute path. Reviewed structured file-tool
arguments now use logical memory URIs in encrypted history and are localized to
explicit same-harness/same-project target bindings. Source and target ownership,
unsafe suffixes, unsupported opaque rewrites and missing references fail closed
with integrity exit 6. Prose, tool results, edit replacements and Write content
remain unchanged. Streamed and buffered paths and append activity inspection
share this policy; failed memory staging is removed.

AD-MEM-011 tests cover typed-field round trips, restaged byte identity, missing
binding refusal before native writes, global unbound sessions, traversal and
resource bounds. The local complete check passes 827 tests in 59 files, lint,
type checking, build and clean-package smoke; global branches are 91.92%
(4337/4718) and the new memory reference rewriter is 100% (96/96). The extended
native drill requires the original Claude UUID, preserved old Read output,
localized historical tool arguments, a new target-native Read and canonical no-op
pushes in both directions. That native candidate has not yet been qualified.

This does not complete reference portability: relative paths, native freeform
patch conversion, historical migration, physical aliases and mixed-client
fencing remain explicit work. The live deployment is unchanged. Do not treat the
new session representation as backwards-compatible before migration/fencing UAT.

The exact-candidate native-claude job `102014736920` in CI `34211942704` on
`6ac73fe` passed. The original UUID resumed on the target with all three
historical memory tool paths localized, its original Read output preserved and
a new native Read returning the target memory bytes. Both post-hydration and
post-return canonical pushes are no-ops. All seven fresh-session/location/
negative controls also pass again. See the expanded
[native report](uat/2026-09-08-native-claude-memory.md). This is reference-backend,
same-host evidence; full-run CI status and broader release gates remain separate.
The complete `34211942704` run subsequently finished successfully in all nine
jobs, including background synchronization and quality/workerd checks.

### Native-cwd relative memory references — 2026-09-08

The documentation follow-up `20182aa` passed CI `34212268123`. A new failing-first
regression then demonstrated that `../memory/topic.md` remained unportable and
its activity could be omitted. Canonical relative memory paths now resolve from
explicit native cwd observations as records are processed, including cwd changes
and Claude user/assistant envelopes. Missing/invalid metadata and noncanonical
alias-sensitive spellings fail closed. Neither process cwd nor prompt/artifact
text supplies directory identity. Conversion precedes workspace URI rewriting;
source-local normalized fields also contribute memory dependency activity.

The complete local check passes 830 tests in 59 files, lint, types, build and
clean-package smoke. Global branches are 91.96% (4384/4767), and the memory
reference rewriter is 100% (141/141). The packaged memory skill now explains
reference-integrity failures and preserves mapping/grant/transcript boundaries;
it was updated with skill-creator and its validator passed.

The native memory fixture now sends relative Read/Edit/Write arguments and
requires their presence in the source's real history before target resume and
return checks. That new exact-candidate native execution is still pending.
Freeform patches, full historical migration, physical aliases, mixed versions,
independent-host packaged/cloud parity and the wider production gates remain open.

The relative candidate `5c127a8` failed CI `34213273513`: eight jobs passed, while
the memory step in native-claude failed in `memory-return`. The ordinary native
session step passed, and the memory drill had reached beyond source-relative
history, target hydration/resume and target writes. This is a failed candidate,
not a native-relative pass. Return diagnostics now distinguish publish, pull and
no-op phases and expose only fixed error classes.

A failing-first local return drill reproduced a source-session `SyncConflict`:
the applied baseline hashed portable bytes rather than the captured native file,
and converting relative fields to absolute paths invalidated the literal
supersequence fallback. Applied session baselines now hash the immutable native
complete-prefix snapshot; remote object digests remain portable. They never hash
a later live file. Six tests cover unchanged and legacy-buffered return, edits
during upload/after push, and incomplete tails before/after capture. Uncaptured
work is preserved with an atomic refusal. Restoring the exact captured fixture
permits return and a no-op push; conflict checks are not bypassed.

The updated full local check passes 836 tests in 59 files, lint, types, build
and clean-package smoke. Global branches are 92.45% (4413/4773); the memory
rewriter remains 100% (141/141). A new native CI run is required to establish
that this correction closes the observed hosted-runner failure. Historical,
mixed-client and concurrent representation-changing append qualification remain
open alongside the wider production requirements.

The corrective candidate `7d130ab` passed native-claude job `102023418948` in CI
`34214643016`. Its actual source history contains all three relative memory tool
arguments; same-UUID target resume, localized history, old Read output, target
native file operations, source return and both no-op pushes pass. All prior seven
fresh-session/location/negative controls pass too. This establishes the selected
pinned native relative-history case after the baseline correction; see the
[executed report](uat/2026-09-08-native-claude-memory.md). The complete run
subsequently finished successfully in all nine jobs. Remaining migration,
concurrency, freeform and cross-host gates are not waived by that result.

## Freeform memory patch implementation — 2026-09-08

AD-MEM-011 now shares one reviewed patch parser between activity extraction and
memory-header conversion. The parser validates the complete envelope before any
mapping, rejects malformed/ambiguous headers, and preserves line endings, trailing
whitespace and authored hunks exactly. Only actual Add/Update/Delete/Move header
paths map to collection IDs; relative paths use native cwd and receiving paths
require the same explicit binding/ownership checks as structured file tools.
Tests cover streamed localization/restaging/activity and ordinary/legacy encrypted
return. The pinned native Codex drill is extended to actually write selected
memory with a relative patch, resume with localized history, update it on target
and return it with no-op pushes. This new native execution is pending; it is not
Codex automatic memory generation or an independent-host packaged/cloud pass.
Workspace/Drop freeform header conversion, arbitrary tool syntaxes, historical
migration and concurrent representation-changing append qualification remain open.

The full local check passes 866 tests in 60 files, lint, typecheck, build and
clean-installed package smoke. Global branch coverage is 92.50% (4446/4806);
the memory rewriter is 100% (156/156), and the shared adapter module is 99.32%
(148/149). These are local results, not the new native scenario's pass record.

Candidate `7adee1b` subsequently passed native-codex job `102027686367` in CI
`34215976635`. The actual pinned harness created memory through a relative patch,
resumed the original UUID with a localized historical header, updated the target
memory and returned exact bytes with both no-op pushes. Prior native assertions
also passed. See the [executed native report](uat/2026-09-08-native-memory-patches.md)
for versions, topology and limits. This does not qualify Codex automatic memory,
arbitrary workspace/Drop patch paths or the independent-host packaged workflow.
The whole `34215976635` run subsequently finished successfully in all nine jobs,
including background synchronization and the quality/workerd/audit gate.

## Late-write protection and concurrent memory history — 2026-09-08

SY-012 reproduced eight cases in which a local change after conflict preflight
was overwritten/deleted by the ordinary materializer. ADR-0026 now captures
bounded descriptor digests and native/parent identities for every ordinary file
and tombstone, then checks the same target immediately before mutation. The
tests preserve streamed-session appends, incomplete tails, Drop edits, new files,
initially identical destinations, replacement and symlink substitutions while
rolling back earlier writes and keeping configuration unchanged. A ninth
regression binds the subsequent buffered conflict read to its captured digest.
Observation tests additionally cover growth/truncation, missing parents, parent
replacement, metadata/link changes, chunk bounds and buffer wiping.

Two failing-first AD-MEM-011 engine tests separately reproduced false return
conflicts after concurrent structured/raw-patch appends with relative memory
history. The streamed ordered-occurrence comparison now projects only reviewed
memory fields on both native sequences with independent cwd state. It preserves
authored content and duplicates, validates all complete records including remote
suffixes, refuses incomplete/unsupported history and closes early-exit streams.
Byte-identical portable merge bases and namespace authority rules do not change.
Unchanged applied native files bypass the unnecessary supersequence comparison.

The exact local check passes 891 tests in 61 files, lint, types, build and the
clean-installed package test. Global branches are 92.54% (4495/4857); file guards
97.77% (44/45), streamed merge 93.75% (75/80). The native Codex scenario now
requires actual original-UUID continuations on both homes before reconciliation,
preserved applied markers until pull, both contributions once and no-op pushes
on both peers. Its new native CI result is pending execution.

These guards are not atomic filesystem compare-and-swap, arbitrary active-writer
hydration safety, persistent SIGKILL recovery, historical/mixed-client migration,
or packaged independent-host qualification. The final-check/rename window and
writes through existing descriptors remain explicit release risks. Generic Drop
permission policy is preserved; dedicated native context restrictions remain.

The native extension on `37b1f7b` subsequently passed job `102034206805` in CI
`34217993203`: real Codex continuations on both homes retain the original UUID,
merge over the shared history, preserve the old applied marker until pull and
retain both contributions once; both peers converge with no-op pushes. All
prior native assertions also pass. See the
[concurrent follow-up report](uat/2026-09-08-native-memory-patches.md). This is
reference-topology evidence, not active-writer or independent-host qualification.
The complete `34217993203` CI run subsequently passed all nine jobs, including
background synchronization and quality/workerd/audit. The original unrelated
background-service-loss investigation is not resolved by this successful run.
