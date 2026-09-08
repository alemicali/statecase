# Statecase TDD, verification, and UAT plan

Status: required delivery plan

Executed evidence: the
[2026-09-06 Daytona and Cloudflare product UAT](uat/2026-09-06-daytona-cloud.md)
passes the packaged CLI, real Codex/Claude shim, two-device authorization,
encrypted Drop round-trip, deletion, conflict, and snapshot subset of this
plan. The
[2026-09-07 Git-baseline Daytona UAT](uat/2026-09-07-git-baseline-daytona.md)
also qualifies explicit ask/auto policy and shallow-clone acquisition against
the live service. The
[2026-09-07 Git workspace restore UAT](uat/2026-09-07-workspace-in-place-restore-daytona.md)
qualifies forward-forking historical workspace replacement, independent-clone
convergence, and offline Git rollback. Native macOS/Linux service-manager,
ARM64, WSL2, large-scale performance, live retention/GC, and real-harness
recovery drills remain open release gates.
Last updated: 2026-09-07
Related: [Implementation specification](./IMPLEMENTATION_SPEC.md)

## 1. Quality objective

Statecase handles valuable, mutable, and sometimes secret state. Passing unit
tests is insufficient. A release must demonstrate that it cannot silently lose,
overwrite, leak, misidentify, or incompletely restore supported data under
normal concurrency and deliberately hostile failure timing.

Every implementation slice follows red-green-refactor:

1. add or update a requirement/test ID;
2. write the smallest failing test at the lowest useful layer;
3. implement until it passes;
4. add failure and boundary cases;
5. refactor with all tests green;
6. run the affected contract and end-to-end suite;
7. attach evidence to the pull request.

No code path that mutates native state, remote head, keys, tokens, tombstones,
snapshots, or retention is accepted without a test written first.

## 2. Test layers

| Layer | Purpose | Runtime |
| --- | --- | --- |
| Unit | pure identity, manifest, merge, crypto, ignore, and policy rules | every PR |
| Property/fuzz | arbitrary paths, record streams, manifests, operation sequences | every PR bounded; nightly extended |
| Adapter fixture | real-shaped sanitized Codex/Claude layouts and versions | every PR |
| Protocol contract | same cases against in-memory and Worker implementations | every PR |
| Storage integration | Miniflare/Workers bindings, D1 migrations, R2, Durable Objects | every PR |
| CLI integration | process, output schema, exit code, keychain abstraction | every PR |
| End-to-end | two clients plus cloud stack and real Git repositories | every PR core subset; nightly full |
| Fault injection | kill, timeout, corrupt, reorder, duplicate, exhaust resources | nightly and release |
| Security | secret scans, authz, tenant isolation, crypto vectors, dependency checks | every PR/release |
| UAT | human-visible workflows on supported OS/harness combinations | release candidate |

Tests MUST use temporary explicit directories. They MUST NOT read or mutate a
developer's real `~/.codex`, `~/.claude`, `~/.statecase`, keychain, Git config,
or cloud account.

## 3. Requirement traceability

Test IDs use these prefixes:

- `ID-*`: identity and mapping;
- `CR-*`: cryptography/key management;
- `PR-*`: protocol/API;
- `SY-*`: sync/revisions/conflicts;
- `AD-CX-*` and `AD-CL-*`: Codex and Claude adapters;
- `WS-*`: workspace capsule/activity;
- `DR-*`: arbitrary Drops;
- `RT-*`: runtime daemon/shims;
- `AU-*`: authentication/authorization;
- `BK-*`: backup/retention/restore;
- `IS-*`: isolation from unrelated tools and user data;
- `SK-*`: agent skill;
- `SEC-*`: security/privacy;
- `PERF-*`: performance/resources.

Every normative implementation section MUST reference at least one test ID in
the implementation pull request. Every fixed production bug receives a
regression ID.

## 4. Unit and property tests

### 4.1 Identity and path mapping

- `ID-001`: SSH and HTTPS remotes for the same Git repository normalize to the
  same workspace ID without retaining credentials.
- `ID-002`: different Git owners/forks remain different.
- `ID-003`: trailing `.git`, host case, ports, IPv6, percent encoding, SCP-like
  SSH syntax, and Unicode repository names normalize deterministically.
- `ID-004`: `/home/a/repo` and `/srv/repo` map to the same logical workspace on
  different devices.
- `ID-005`: two clones on one device require an explicit mapping decision.
- `ID-006`: nested monorepo roots and worktrees cannot collide accidentally.
- `ID-007`: a non-Git directory remains local until explicitly attached.
- `ID-008`: absolute paths never appear in object/session uniqueness keys.
- `ID-009`: case-insensitive and case-sensitive target mappings detect
  collisions before materialization.
- `ID-010`: randomized path sets round-trip through manifest normalization
  without traversal or ambiguity.
- `ID-011`: moving or detaching a device-local workspace mapping never moves
  or deletes files or cloud state; path changes clear stale applied state,
  collisions and invalid Git destinations fail without configuration mutation,
  and same-path operations are idempotent.
- `ID-012`: a portable session is rebound to the device-local native relative
  path that published or materialized it. A later merge updates that exact
  path without creating a canonical duplicate; a fresh device uses and records
  the canonical fallback. Dry-runs and failed operations do not mutate the
  binding, deletions clear it, and traversal or destination collisions fail
  before materialization.

### 4.2 Manifest and merge

- `SY-001`: canonical manifest serialization is byte-deterministic.
- `SY-002`: disjoint edits commute regardless of commit arrival order.
- `SY-003`: identical concurrent objects deduplicate.
- `SY-004`: complete JSONL append streams with a byte-identical common prefix
  converge deterministically, deduplicate shared occurrences, preserve each
  branch order, and retain dependency activity from both branches.
- `SY-005`: a rewritten accepted prefix or incompatible record order fails
  closed while preserving the remote head and local branch as conflict sides.
- `SY-006`: delete versus modify creates a conflict, not silent deletion.
- `SY-007`: binary conflict preserves both variants.
- `SY-008`: safe three-way text merge produces the same result on every client.
- `SY-009`: randomized valid operation sequences converge after all clients
  exchange revisions.
- `SY-010`: randomized invalid sequences never advance the head.
- `SY-011`: committing an unrelated namespace must not acknowledge remote-only
  content as locally applied, including unsupported future harness paths. A
  repeated push preserves the remote head; supported content subsequently
  hydrates, while unsupported content fails closed without advancing markers.
- `SY-012`: a destination changed or created after preflight must not be
  overwritten or deleted. Inject changes immediately before commit for streamed
  sessions, Drops, tombstones, absent/initially identical files, incomplete tails,
  replacement and symlinks; require earlier-write rollback and unchanged applied
  state. Verify bounded descriptor hashing, buffer cleanup, read-time growth/
  truncation, parent/metadata/link changes and redacted refusal (ADR-0026).

### 4.2a Portable settings (ADR-0023)

- `AD-CFG-001`: allowlisted JSON/TOML projection, strict syntax, duplicate keys,
  known-field type validation and fixed redacted errors.
- `AD-CFG-002`: range edits preserve unknown lexemes, comments, escapes, BOM
  and large local-only numbers; randomized round trips and resource limits.
- `AD-CFG-003`: canonical per-field envelopes and local registry resolution;
  reject unknown versions, identities, encodings, extra fields and payload types.
- `AD-CFG-004`: Codex preferences; retain authority/provider/path fields.
- `AD-CFG-005`: Claude preferences; retain auth/env/hooks/policy fields.
- `AD-CFG-006`: descriptor-safe reads, absent roots/files, links/FIFOs,
  ownership/modes, bounds, source/root mutation and stale-snapshot refusal.
- `AD-CFG-007`: two-device filtered transfer, preview, canonical applied digests,
  disjoint preference merges, secret-only no-op and field-only deletion.
- `AD-CFG-008`: local edit/delete versus divergent remote preference conflicts.
- `AD-CFG-009`: local-only changes during apply abort and roll back earlier
  unrelated writes without changing applied markers.
- `AD-CFG-010`: malicious raw paths, unknown virtual versions/fields and invalid
  authenticated payloads fail without native-file mutation.
- `AD-CFG-011`: historical restore across key epochs, one physical recovery
  target, current secret preservation and failed-commit emergency rollback.
- `AD-CFG-012`: actual pinned Codex/Claude provider requests use the synced
  model and effort. Fresh destination sessions exclude restored-session metadata
  as an alternative explanation; an explicit CLI effort override changes the
  request without mutating the synced native file. The validator has deliberate
  wrong/missing-model and wrong/missing-effort negative controls.

AD-CFG-001 through 011 cover local implementation. AD-CFG-012 is a native
qualification driver whose [passing selected-preference execution evidence](uat/2026-09-08-native-effective-preferences.md)
is recorded separately. Disposable Codex projects receive their own explicit
local trust during setup, before transfer, so first-use trust initialization
cannot be mistaken for a preference mutation. Source trust must not transfer.
Before release, repeat effective-preference checks with the exact packed CLI on
two independent hosts, native precedence, background writes, revocation/scopes,
mixed-client upgrade/downgrade refusal, SIGKILL/sleep/reboot and the remaining
instruction/memory cases. Package smoke verifies included parser licenses.

### 4.3 Cryptography

- `CR-001`: published test vectors for every envelope version.
- `CR-002`: encrypt/decrypt round-trip for empty, boundary, compressed, and
  maximum-size chunks.
- `CR-003`: one-bit mutation in header, AAD, nonce, ciphertext, or tag fails.
- `CR-004`: wrong vault/scope/key/object ID fails authentication.
- `CR-005`: object IDs are deterministic inside a scope but unlinkable across
  scopes/vaults.
- `CR-006`: nonce source collision simulation is detected or safely handled.
- `CR-007`: keys and plaintext are absent from serialized errors and logs.
- `CR-008`: old envelope readers remain deterministic after new versions ship.
- `CR-009`: device wrap/unwrap and recovery vectors work across supported Node
  and OS builds.
- `CR-010`: rotation creates a fresh root at exactly the next epoch, commits
  envelopes for the exact active-device set atomically, and excludes revoked
  devices. Missing/duplicate recipients, missing exchange keys, membership or
  epoch races, old-epoch/legacy commits, and stale capability creation fail
  without partial mutation. Active devices ingest contiguous envelope history;
  a gap or stale recovery kit fails closed. A lost successful HTTP response is
  accepted only after decrypting the current device's envelope and matching the
  candidate key; an unavailable reconciliation preserves the recovery kit and
  old local authority. Rotation revokes all existing vault capabilities.
  Regression evidence also covers disjoint offline edits, same-session append
  merges, and historical Drop/harness restores across epochs; previews leave
  objects and heads unchanged. The workerd suite exercises late coordinator
  commits, a persisted epoch floor while D1 remains behind, completion by a
  valid retry, stale capability insertion after HTTP preflight, immutable
  device exchange keys, registration that omits an existing public key, and
  rejection of non-owner envelope issuers inside D1. Injected infrastructure
  failures remain ambiguous (HTTP 5xx), preserve the durable write fence, and
  permit a subsequent valid retry without breaking existing coordinator stubs.
  Enrollment rejects a stale recovery epoch at both the API and D1 insertion
  boundary with zero added memberships; valid replacement enrollment and
  idempotent owner enrollment preserve their intended roles.
  Actual process-reset/late-D1 completion fault injection remains a release
  qualification case; injecting a durable floor proves fencing and retry, not
  the whole infrastructure failure sequence.

`CR-011` (local credential protection): encrypt the complete legacy payload,
including historical/scoped keys and opaque future fields; bind it to the local
key reference; reject wrong key/context, corrupt envelopes, unknown protected
metadata, unsafe file types/modes, invalid UTF-8/JSON, and oversized documents.
Keys and raw native/filesystem errors never appear in CLI output. Authenticate
the old document and encrypt its replacement with one retrieved key. Preserve
independent writes and fail closed instead of downgrading to plaintext.

### 4.4 Ignore and filesystem policy

- `WS-001`: `.git`, sockets, FIFOs, devices, outside-root symlinks, and unsafe
  hard-link cases are excluded.
- `WS-002`: `.statecaseignore`, `.gitignore`, built-ins, and explicit rules
  obey documented precedence.
- `WS-003`: `.env`, PEM keys, credentials, dependency trees, and build caches
  are excluded/flagged by default.
- `WS-004`: path traversal, absolute archive paths, NUL, alternate separators,
  Unicode normalization, and reserved names cannot escape staging.
- `WS-005`: file changes during hashing cause retry, not a mixed snapshot.
- `WS-006`: symlink target swap during scan cannot exfiltrate outside content.
- `DR-001`: Drop relative paths round-trip across separators and filesystem
  case rules.
- `DR-002`: publish/consume/append/two-way modes reject forbidden mutations.
- `DR-003`: removing a Drop deletes only its device-local mapping and applied
  marker; local files and the encrypted remote namespace remain unchanged.
- `DR-004`: Drop status reports local-root availability and applied-versus-head
  revision alignment without claiming to have scanned local file changes.

## 5. Adapter fixture tests

Fixtures are sanitized, minimal, and tagged with observed harness version and
platform. Unknown fixture fields are retained or ignored according to adapter
policy; they are never uploaded merely because they are present.

### 5.1 Codex

- `AD-CX-001`: resolve default and overridden `CODEX_HOME`.
- `AD-CX-002`: resolve separately overridden `CODEX_SQLITE_HOME` and exclude
  active DB/WAL/SHM files.
- `AD-CX-003`: ingest complete session JSONL and defer an incomplete tail.
- `AD-CX-004`: tolerate a line appended during scan without duplicating it.
- `AD-CX-005`: detect prefix rewrite/truncation and fork safely.
- `AD-CX-006`: classify user skills, repository skills, portable config,
  auth, logs, caches, binaries, and unknown paths correctly.
- `AD-CX-007`: materialized sessions remain discoverable/resumable from the
  mapped workspace or are reported as incompatible.
  Native Codex 0.153.4 UUID resume is now exercised by `npm run uat:native-codex`:
  real read/write tools, engine-level encrypted transfer, fresh native SQLite,
  non-mutating hydration preview, mapped CWD, original history, same UUID, and
  the freeform patch dependency. The loopback provider and reference transport
  do not qualify hosted inference, live Cloudflare, or a physical second host.
  Regression coverage also runs normalization with the process CWD inside the
  mapped workspace: ordinary strings, native event types, model names, and
  relative arguments remain unchanged while absolute workspace paths relocate.
  The native drill exercises both source/target sync CWDs and return sync.
- `AD-CX-008`: very large sparse/session files stream in bounded memory.

### 5.2 Claude

- `AD-CL-001`: resolve default and configured Claude roots.
- `AD-CL-002`: map a logical workspace to a different native project path.
- `AD-CL-003`: complete/incomplete/re-written JSONL behavior matches Codex
  safety guarantees.
- `AD-CL-004`: skills/settings/memory/plans classification respects default
  secret and cache exclusions.
- `AD-CL-005`: session IDs shared across projects do not collide.
- `AD-CL-006`: restored sessions are listed/resumable before apply is marked.
  `npm run uat:native-claude` exercises the UUID-resume subset with real Claude
  Code 2.1.263: tracked Read/Edit, untracked Write, exact Git baseline, strict
  non-mutating hydration preview, changed home/project path, original prompt
  and tool results, and return sync. A deterministic loopback Messages provider
  drives the real tools; the actual engine uses reference storage on one host.
  Interactive listing, runtime pre-apply compatibility verification, packaged
  live-cloud cross-host resume, and other versions remain separate gates.
- `AD-CL-007`: changed native format fails closed and preserves raw local data.

## 6. Workspace capsule tests

- `WS-010`: clean repository records base commit and transfers no tracked file
  content.
- `WS-011`: unstaged modification restores identical bytes and status.
- `WS-012`: staged plus differently modified worktree restores both index and
  working-tree variants.
- `WS-013`: added, deleted, renamed, copied, executable-bit, empty file, binary,
  safe symlink, and submodule states round-trip.
- `WS-014`: detached HEAD and unborn branch have deterministic behavior.
- `WS-015`: shallow clone missing base commit fetches through configured Git
  flow and restores the captured symbolic branch, or returns
  `BASELINE_UNAVAILABLE` without partial apply; an unreachable later workspace
  rolls back earlier automatic checkouts and target refs and leaks no remote URL
  or credential-shaped diagnostic.
- `WS-016`: dirty destination produces a conflict preview and remains unchanged.
- `WS-017`: Git LFS pointer and absent LFS content are reported distinctly;
  `ask|never` make no network/mutation, while `auto` tries the local cache then
  the existing origin, verifies size/SHA-256, redacts failures, and rolls back
  partial materialization.
- `WS-018`: nested repository/submodule boundaries do not leak files.
- `WS-019`: untracked ignored file referenced by a session is reported but not
  silently uploaded.
- `WS-020`: permitted untracked file referenced by a session is included.
- `WS-021`: external read appears as unresolved dependency until a Drop/policy
  supplies it.
- `WS-022`: parsed read/write events use workspace-relative canonical paths.
  Regression coverage includes Codex 0.153.4 freeform patch headers, move
  destinations, CRLF, payload/header ambiguity, incomplete envelopes, and
  external/unsafe paths. Arbitrary shell/code reads are not thereby traced;
  extracted dependency completeness and tool-observation coverage are separate.
- `WS-023`: transcript lies about a path; filesystem/Git reconciliation remains
  authoritative.
- `WS-024`: optional OS activity events missing/reordered/duplicated do not
  affect capsule correctness.
- `WS-025`: applying the same capsule twice is idempotent.
- `WS-026`: baseline plus overlay produces the recorded final content digest.
- `WS-027`: a Session Capsule pins the exact harness, workspace, baseline, and
  Drop revisions observed at checkpoint time.
- `WS-028`: historical resume atomically hydrates independently pinned harness,
  workspace, and Drop revisions even when their current heads have advanced;
  dry-run and any missing pinned object leave every target untouched.
- `WS-029`: a missed filesystem event is recovered by final Git/index
  reconciliation and included in the overlay.
- `WS-030`: unchanged tracked reads record Git object IDs and upload no source
  bytes.
- `WS-031`: changed/untracked/Drop-backed reads pin content/revisions according
  to policy.
- `WS-032`: strict, warn, and best-effort hydration handle unresolved external
  dependencies exactly as documented.
- `WS-033`: explicit historical workspace restore replaces dirty, detached, or
  unborn HEAD/index/worktree state only after durable Git-aware recovery,
  rejects initialized submodules and special-file collisions, rolls back an
  optimistic commit failure exactly, and forks the remote revision forward.
- `WS-033`: local workspace capsule preview reports only bounded Git
  baseline/ref and overlay size/count metadata, performs no network or config
  mutation, emits no captured file bytes, and rejects identity-only mappings.
- `WS-034`: ordinary return sync accepts a peer continuation when the current
  workspace still exactly matches its authenticated last-applied capsule,
  including staged/worktree divergence and untracked files. Truly new local
  changes remain conflicts. Preview, missing/corrupt applied history,
  source races, baseline changes, multiple-workspace rollback, and interrupted
  recovery must be covered before automatic replacement is release-qualified.
  The initial regression now passes locally; new tests cover index-lock
  exclusion/ownership, ignored/directory collisions, unborn/symlink overlays,
  editor mutations at the materializer boundary, and authenticated but
  substituted prior revisions. The fresh native engine-level return-sync rerun
  passed on Daytona. Packaged/live cross-host testing, persistent interruption
  recovery, broader races, and workspace critical coverage remain gates.
  Further fault cases cover independent source/target branch advancement,
  foreign HEAD/ref locks, creation/deletion/detached/unborn transitions,
  preservation of newer files during rollback, and retention/exclusion of
  recovery artifacts when exact rollback cannot safely complete.
  Valid overlay blobs targeting `.git/config`, `.GIT/config`, or reserved
  recovery artifacts must be rejected before materialization. Upper/mixed-case
  artifact names, UUIDs, suffixes, and parent components remain reserved even
  on a case-sensitive sender; Drop publication must also omit these variants.

## 7. Protocol and cloud contract tests

The same suite runs against an in-memory reference implementation and the
deployed Worker test environment.

- `PR-001`: OpenAPI/request schemas accept every valid fixture and reject every
  invalid fixture identically.
- `PR-002`: repeated operation/idempotency key returns the original commit.
- `PR-003`: same idempotency key with different payload returns `409`.
- `PR-004`: stale base returns structured rebase/conflict information.
- `PR-005`: conditional duplicate object upload is an idempotent success.
- `PR-006`: oversized body, object count, manifest, and nesting are rejected
  before resource exhaustion.
- `PR-007`: streamed upload does not buffer the full object.
- `PR-008`: pagination has no duplicates or gaps under concurrent additions.
- `PR-009`: 401/403/404 behavior does not leak cross-tenant existence.
- `PR-010`: Durable Object restart/eviction preserves head/idempotency state.
- `PR-011`: D1 migration from every released schema succeeds and is reversible
  where promised.
- `PR-012`: R2 missing/corrupt object prevents commit or pull as appropriate.
- `PR-013`: rate-limit response includes bounded retry guidance; client jitter
  avoids synchronized retry storms.
- `PR-014`: protocol minor-version negotiation ignores optional fields; unknown
  required capability fails explicitly. ADR-0027 requires bounded public health
  negotiation without credentials, one shared handshake per client, retry and
  426 invalidation, exact 16 KiB response limits and redacted stream failures.
  Inventory every protected route: incompatible device/capability requests must
  fail before domain work. Real workerd checks R2/head preservation and a D1
  bootstrap grant surviving refusal then redeeming exactly once. CLI bootstrap
  returns JSON exit 6 without configuration/credential changes or secret upload.
  Actual old packaged binaries, local profile upgrade/downgrade and deployed
  matched-pair cutover remain separate required UAT; synthetic missing headers
  are not evidence that offline old binaries are fenced.
- `PR-015`: Worker logs contain no plaintext body or authorization material.

### RT-017 Local profile migration and downgrade refusal

ADR-0028 requires framed version/capability validation; non-mutating status and
preview; explicit confirmation; exact owner-only prior-document backup; active
daemon/config/supervisor refusal; source recheck and stale-writer denial; safe
I/O failures and retry; malformed/oversized/link/type/UTF-8 input rejection;
retention of optional config payload fields and pre-existing staging collisions.
New CLI actions must refuse legacy profiles before credentials, network, skills
or native mutation, with the explicit profile and daemon-stop paths retained.
`npm run uat:profile` must qualify actual clean-installed historical/current
packages, including successful legacy use before migration and seven rejected
config-dependent commands after migration with exact state preservation. It does
not prove all historical commands or active old-writer, power-loss or cross-host
safety. Those remain separate release tests; do not substitute a JSON.parse-only
unit assertion for historical executable evidence.

## 8. Authentication and authorization tests

- `AU-001`: browser/device-code completion cannot be replayed.
- `AU-002`: refresh rotation invalidates the replaced refresh token.
- `AU-003`: expired, revoked, malformed, wrong-audience, and wrong-signature
  tokens fail.
- `AU-004`: single-use bootstrap capability succeeds once under concurrency.
- `AU-005`: bootstrap scope cannot enumerate another workspace/vault/category.
- `AU-006`: append-only sandbox cannot overwrite or delete prior state.
- `AU-007`: secrets scope cannot be granted to ephemeral v1 capabilities.
- `AU-008`: device revocation blocks subsequent requests and key wrapping.
- `AU-009`: account A cannot infer object/workspace IDs from account B.
- `AU-010`: clock skew does not extend server-enforced expiry.
- `AU-011`: environment, process arguments, crash output, doctor bundle, and
  shell completion never expose tokens.
- `AU-012`: credential status/preview do not call the native backend or create
  an absent profile. Confirmed migration verifies native key read-back and
  leaves only an encrypted owner-only payload on disk. Native helper input uses
  pipes, an environment allowlist and bounded runtime/output. Real isolated
  Secret Service tests must qualify fresh native storage and process restart;
  native macOS uses an explicitly addressed disposable password-protected
  keychain and verifies quoted stdin commands, missing/locked-store refusal,
  cross-process reopen, explicit unlock, encrypted logout and exact cleanup.
  Selected-path lookup must not fall back to the default search list. Mocked
  tests cover control injection, escaped byte limits, environment filtering,
  canonical output and foreign-backend refusal before native calls. OS reboot
  and interactive unlock remain separate gates.
  Launchd definitions must pin an explicit keychain path with XML escaping,
  retain ownership checks for old/new dictionaries, reject duplicate/unknown
  dictionaries, and remain stoppable/removable without repeating the path.
  Native lifecycle evidence checks the manager's effective environment using
  an unused synthetic keychain path; it is not an authenticated daemon UAT.
- `AU-013`: unavailable/locked/missing/wrong native keys preserve the previous
  file and fail closed. Test stale read/save, active foreign locks, replaced
  locks, precommit failure, retained native keys, redacted errors and encrypted
  logout. CLI requires exactly one of preview/confirmation and uses stable
  usage `2`, conflict `5`, integrity `6`, and availability/commit `7` exit codes.

## 9. Daemon and shim tests

- `RT-016`: kernel-backed exclusion survives process death and overlapping
  stale-lock recovery. Pause one reclaimer and attempt another; it must not
  steal the lock. After SIGKILL, eight independent contenders must yield
  exactly one owner. Kill at pre-reclaim and pre-publication boundaries and
  retry; never publish partial owner JSON or lose kernel exclusion. Cover
  forced garbage collection while an acquisition is suspended at each boundary:
  native ownership must remain rooted until explicit release or process death,
  not depend on reachability of an async continuation. Run GC after normal
  acquisition/release too and preserve exactly-one-winner restart checks. Cover
  v2 PID reuse, live legacy owner refusal, unsafe/oversized metadata, foreign
  replacement, native file creation faults, persistent inode identity and
  case-insensitive exclusion of all mutex/sidecar names from sync/materialization.
  Native UAT bundles must also load their real SQLite dependency and acquire a
  mutex from a temporary directory outside the repository; an in-repository
  test runner does not establish that module-resolution boundary.

- `RT-015`: independent authenticated daemon processes converge without manual
  sync after setup, preserve a running journal operation across an interrupted
  object upload and SIGKILL, restart offline, reconcile disjoint peer writes,
  propagate deletion, and avoid idle revisions. Local workerd evidence is
  separate from live Cloudflare/native-manager qualification.
  The combined Linux/live-service result is recorded in
  `uat/2026-09-08-native-cloud-background.md`; its two installations share a host.
- `RT-001`: setup resolves the real harness binary and refuses recursion.
- `RT-002`: stdin/stdout/stderr, TTY dimensions, colors, and interactive input
  pass through unchanged.
- `RT-003`: SIGINT/SIGTERM/SIGHUP and terminal resize reach the child; exit code
  is preserved.
- `RT-004`: offline preflight follows policy and leaves a visible queued state.
- `RT-005`: final flush timeout does not alter the harness exit code or discard
  the journal.
- `RT-006`: crash/kill at every journal transition replays idempotently.
  Prerequisite artifact tests now cover failed exclusive reservations, legacy
  backup preservation, directory substitution, unknown-child preservation and
  actual SIGKILL between file installations. That kill test verifies exact
  retained originals, not restart recovery; full durable replay remains open.
  ADR-0030 subsequently adds an internal coordinator and separate-process actual
  SIGKILL/replay tests for prepared/intent/backup/install/commit boundaries,
  interrupted recovery, file creation/deletion/symlinks, two roots, committed
  cleanup, changed original descriptors, corrupt journals and bounded approved
  paths. This is not ordinary CLI/Git/profile crash qualification; those outer
  transaction and full fault-injection requirements remain open.
  ADR-0031 adds paired native/profile SIGKILL replay, profile-absent recovery,
  final metadata ordering, outer/inner decision agreement, pending-reader/writer
  fencing, stale proposal invalidation and administrative daemon stop. These
  internal coordinator tests still do not qualify Git participants or enable
  durable recovery in normal sync/daemon/shim reconciliation.
  ADR-0032 tests pre-mutation Git preparation with a real SIGKILL at handoff:
  exact original HEAD/index/worktree and no stranded index lock; staged/worktree
  distinction, unborn/detached/packed/linked/multi-root states, duplicate/writer
  refusal and repeated guards. Full/shallow/multi-batch fallback acquisition must
  preserve local refs and FETCH_HEAD even with conflicting configured refspecs.
  This proves safe preparation, not persistent applied-Git recovery.
  ADR-0033 adds internal native lock ownership tests: fsynced descriptors before
  hard-link publication, real Git writer exclusion, actual process death before
  and after publication, repeated interrupted release, directory-durability replay,
  foreign/recreated lock refusal, exact grants, descriptor/parent/anchor integrity
  and non-mutating preview. This suite is also required on the disposable macOS
  runner; production outer-journal integration remains open.
  ADR-0034 joins exact repository-derived index grants and durable native lock
  descriptors to the real ConfigStore checkpoint. Actual SIGKILL/restart tests
  cover linked-worktree index/profile/file rollback, committed cleanup and each
  release boundary. Exercise all-participant validation, lost ownership during
  forward/caught/restart paths, layout/grant/descriptor tampering, non-mutating
  preview, ambient Git redirection and sibling/index-kind refusal. Full HEAD/ref,
  prepared-workspace/runtime and cross-host qualification still remain required.
- `RT-007`: two daemons for one profile cannot run concurrently.
- `RT-008`: sleep/wake and network change trigger reconcile without a storm.
- `RT-009`: rapid file events debounce but the maximum publish deadline holds.
- `RT-010`: IDE launch without shim still synchronizes through daemon.
- `RT-011`: ephemeral `statecase run` needs no systemd/launchd.
- `RT-012`: uninstall removes only Statecase-owned shims/services and restores
  prior PATH behavior.
- `RT-014`: start/stop preserve the active profile boundary, never restart an
  already running writer, and refuse foreign/unknown definitions before any
  manager mutation. Missing launchd services are distinguished from permission,
  missing-domain, timeout, and unknown-format errors. CLI JSON reports a manager
  request, not successful remote synchronization.
- `RT-013`: native services pin the installing Node interpreter, preserve
  literal special-character paths, reject control-character injection, and
  survive a real manager-driven SIGKILL/restart without duplicate writers.
  Linux evidence: `uat/2026-09-08-native-systemd.md`; macOS evidence:
  `uat/2026-09-08-native-launchd.md`. Authenticated background convergence remains
  a separate gate.

## 10. Backup, retention, and restore tests

- `BK-001`: every accepted commit references a readable immutable manifest.
- `BK-002`: hourly/daily/monthly retention selects deterministic checkpoints
  across DST, leap day, timezone changes, and clock skew.
- `BK-003`: protected snapshot survives normal retention.
- `BK-004`: garbage collection preserves every object reachable from head,
  retained snapshot, conflict, pending commit, and grace period.
- `BK-005`: concurrent snapshot creation and garbage collection cannot race.
- `BK-006`: dry-run lists exact creates/replaces/deletes and byte requirements.
- `BK-007`: in-place restore excludes the daemon, refuses a live harness or
  malformed activity marker, closes start-versus-restore races, and rejects
  SQLite database/WAL/SHM targets before recovery or mutation.
- `BK-008`: disk-full during staging leaves destination and applied revision
  unchanged.
- `BK-009`: restore validation or remote-commit failure rolls back exactly,
  preserves an independently usable emergency copy, and verifies every backup
  before any explicit offline rollback mutation.
- `BK-010`: selective workspace/session/category restore cannot cross scope.
- `BK-011`: restoring a tombstone creates a new revision.
- `BK-012`: total cloud loss can be recovered from a separately exported,
  documented recovery artifact when that feature is enabled.
- `BK-013`: legacy, pre-tracking, incomplete-metadata, and over-limit graphs
  fail conservative without deleting objects.
- `BK-014`: a Worker failure during deletion cannot admit a racing commit or
  select already-pruned history after lease expiry.

## 11. Product-isolation tests

- `IS-001`: installation and setup do not discover, read, import, or mutate
  AgentStash or ClawStash configuration and repositories.
- `IS-002`: package dependency graphs contain no AgentStash, ClawStash, or
  Restic dependency.
- `IS-003`: default paths, service names, environment variables, credentials,
  locks, ports, and cloud prefixes are Statecase-specific.
- `IS-004`: running backup tools and Statecase concurrently creates no lock,
  credential, path, process, or service-name collision.
- `IS-005`: uninstall removes only Statecase-owned artifacts.

## 12. Skill tests

- `SK-001`: installer places/symlinks the canonical skill into each supported
  harness discovery path and is idempotent.
  Claude install/verify/uninstall must resolve the same `CLAUDE_CONFIG_DIR`
  as the adapter, including relative overrides and unchanged defaults. An
  isolated HOME test must prove no unused default `.claude` tree is created.
- `SK-002`: explicit "connect to Statecase" invokes status then the correct
  deterministic command.
- `SK-003`: implicit hydrate/publish/snapshot/conflict prompts select the skill.
- `SK-004`: unrelated backup, generic cloud-drive, Git, or file prompts do not
  spuriously invoke it.
- `SK-005`: configured environment bootstrap is used without displaying the
  token.
- `SK-006`: missing credentials causes a precise login/bootstrap instruction,
  not a fabricated success.
- `SK-007`: restore overwrite pauses for explicit authorization.
- `SK-008`: malformed JSON/unknown CLI schema is reported safely.
- `SK-009`: model refusal, termination, or non-invocation cannot stop daemon
  persistence.

## 13. Paranoid fault and adversarial matrix

The release suite injects failures immediately before and after each persistent
write, rename, upload, head compare, commit, apply marker, token redemption,
and GC mark/sweep transition.

It also covers:

- process kill -9, host reboot, container eviction, and power-loss simulation;
- DNS failure, TLS reset, truncated body, duplicate body, delayed response,
  timeout after server success, HTTP proxy, and captive portal;
- reordered/duplicated filesystem events and mtime moving backward;
- files changing size while read, inode reuse, symlink race, permission loss,
  disk full, read-only filesystem, quota, and descriptor exhaustion;
- 0-byte, sparse, multi-gigabyte, highly compressible, incompressible, invalid
  UTF-8, CRLF/LF, Unicode, and maliciously nested content;
- 100 clients committing to one vault, two clients using one device credential,
  and a client restored from a VM snapshot with stale journal state;
- R2 returning stale/missing simulated data, Durable Object restart, D1
  transaction failure, and partially applied deployment/migration;
- malicious manifest with traversal, duplicate logical IDs, integer overflow,
  decompression bomb, excessive fan-out, or conflicting required features;
- rollback attack to an old signed manifest, object substitution, and replayed
  bootstrap/commit requests;
- secret content inserted into filenames, errors, Git remotes, session events,
  and telemetry fields;
- revoked device continuing offline for a week and later reconnecting;
- destination filesystem with different case sensitivity, normalization,
  permissions, symlink support, path length, and reserved names;
- Git force-push making a baseline unreachable, deleted remote, private remote
  without credentials, shallow clone, submodules, LFS, worktrees, and conflicts;
- sandbox killed before final flush; verify bounded loss against periodic push.

## 14. Performance tests

- `PERF-001`: warm no-op preflight p95 under two seconds.
- `PERF-002`: 100,000-entry scan and 20-GiB initial sync remain bounded in
  memory and paginate correctly.
- `PERF-003`: append to a 2-GiB JSONL transfers only new chunk/tail data.
- `PERF-004`: clean 100,000-file Git repository does not hash/upload all tracked
  files on each sync.
- `PERF-005`: dedup of identical chunks across revisions reduces transferred
  bytes as specified.
- `PERF-006`: watcher burst of 100,000 events coalesces without lost reconcile.
- `PERF-007`: 100 concurrent devices do not violate coordinator correctness.
- `PERF-008`: cache limit and eviction never remove pending/unapplied objects.

Current automated evidence covers segmentation-independent streaming chunks,
incremental digest compatibility, secure staging cleanup, corrupt envelope and
false size/digest rejection, file-backed atomic install, protocol descriptors,
new-vault 1.1 bootstrap, and an end-to-end multi-chunk append proving that no
previously present object ID is uploaded. `PERF-002` remains a release
acceptance test. `PERF-003` passed with a 2,147,483,737-byte session, 514
initial objects, two-object append uploads, two-object concurrent-merge upload,
and verified convergence on both native paths; see the
[two-GiB Daytona UAT](uat/2026-09-07-two-gib-session-daytona.md). Automated file
and two-device tests cover suffix-only concurrent merge over a streamed common
base and the streaming supersequence acceptance check. Disk-space unit tests
cover numeric and bigint filesystem counters, exact reserve boundaries, and
invalid sizes; all staging paths also exercise the real filesystem preflight
in integration.
Regression coverage recreates a missing temporary root before allocation and
removes the empty private staging directory when preflight capacity is
insufficient.

Performance baselines run on recorded hardware profiles. A statistically
significant regression requires an explicit approved waiver.

## 15. UAT environments

Minimum release-candidate matrix:

| Environment | Harness | Mode |
| --- | --- | --- |
| macOS current supported, Apple Silicon | Codex + Claude | persistent daemon/shim |
| Linux current LTS, x64 | Codex + Claude | persistent daemon/shim |
| Linux ARM64 | at least one harness | persistent |
| WSL2 | Codex + Claude smoke | compatibility |
| Daytona-like Linux container | Codex + Claude | ephemeral bootstrap/run |
| Offline laptop simulation | both | queued/reconnect |

Each UAT begins with disposable test accounts, vaults, harness profiles, and
repositories. Test data contains unique canaries so missing, duplicated, or
leaked content is detectable.

## 16. UAT scenarios

### UAT-01 First persistent device

Install from the published artifact, log in, create a vault, preview discovery,
enable both harnesses, install skills/shims/daemon, perform first sync, verify
R2/D1/Worker logs contain no plaintext, and verify no native file changed.

Acceptance: setup under five minutes excluding upload time; status is healthy;
all excluded categories are explained.

### UAT-02 Different home and checkout paths

Work in `/Users/test/src/project`, create a Codex session, modify/stage/create
files, and sync. On Linux map the same workspace to `/srv/work/project`, obtain
the pinned Git baseline from a shallow clone using `--git-fetch auto`, hydrate,
and resume. Repeat with `ask` and verify no fetch or checkout occurs before
explicit approval.

Acceptance: same logical workspace/session; exact index/worktree bytes; no
requirement for matching absolute paths; Session Capsule dependency closure is
complete and matches the originating checkpoint.

### UAT-03 Claude to a second machine

Create a Claude session with reads of tracked files, a write to a tracked file,
and a permitted untracked note. Hydrate on another machine.

Acceptance: session is discoverable/resumable; baseline satisfies read-only
files; overlay contains changed/untracked content; the dependency report has
zero unresolved entries (resolved dependencies must remain visible).

The packaged/live-cloud peer driver is
`scripts/uat/cloud-native-claude-peer.mjs`. Run independent `init` phases on two
disposable sandbox installations, then source `source`, target `hydrate` and
`resume`, and source `return`. Native turns run through the installed transparent
shim, not a source-imported engine. Assert independent device authorization,
identical synthetic Git baseline on isolated filesystems, strict non-mutating
preview, changed native project path, original UUID/prompt/tool results, remote
capsule advancement from the shim's final flush, and return of files plus native
history. Transfer no transcript/workspace/profile outside Statecase; only the
encrypted recovery kit and opaque IDs cross the orchestration channel.
Pin package hash, harness version, both sandbox identities and cloud deployment.
Temporary signup access must be restored even on failure; exact fixture account,
vault objects, and owned sandbox cleanup require separately recorded verification.
Deterministic loopback model responses do not qualify hosted inference, and a
foreground shim run does not establish daemon/sleep/reboot behavior.

### UAT-04 External dependency and Drop

Have an agent read a file outside the repository. Verify it is reported but not
uploaded. Add its parent as a read-only Drop, sync, map it to a different target
path, and hydrate again.

Acceptance: no silent external copy; explicit Drop resolves the dependency.

### UAT-05 Concurrent work

Take two devices offline at the same revision. Append different sessions and
different complete records to the same session, change disjoint config, and
modify/delete the same workspace file. Use different native session and
workspace paths on each device, then reconnect in both orders.

Acceptance: compatible changes converge; modify/delete remains an explicit
preserved conflict; the same-session merge updates each device's existing
native file without creating a second divergent copy; no bytes are silently
lost.

### UAT-06 Ephemeral sandbox

Create a single-use, two-hour, one-workspace read+append capability. Inject it
as a secret, ask the harness through the Statecase skill to attach/hydrate,
work, and publish. Attempt overwrite, deletion, secrets access, reuse, and
cross-workspace access.

Acceptance: intended flow succeeds; every escalation fails; secret never
appears in transcript/log/process arguments.

Automated status: the synthetic CLI UAT now covers protected token creation,
one-time rootless bootstrap, scoped pull, append publication, persistent-device
reconciliation, and revocation. Real Daytona-like Codex and Claude runs plus
process/log inspection remain required before public release.

### UAT-07 Offline and crash recovery

Disconnect during an object upload and kill the client at selected journal
states. Restart offline, continue using the harness, reconnect, and sync.

Acceptance: native work continues, queued state is visible, transfer resumes,
and the final revision contains each logical change exactly once.

The automated `npm run uat:background` drill covers authenticated CLI daemons
against local workerd/D1/R2 using a per-device fault proxy. It holds an encrypted
object PUT before upstream acceptance, verifies a persisted running journal
row, kills/restarts offline, and later verifies that the original row commits.
Native harness use and live-service/native-manager convergence remain separate
UAT requirements; this test must not be used to claim those are complete.

### UAT-08 Restore drill

Delete and corrupt selected local data, create later remote tombstones, then
restore a protected older snapshot first to staging and then in place.

Acceptance: dry-run is exact, validation passes, tombstoned data returns via a
new forward revision, the old remote head is never rewound, unrelated/current
data is untouched, and the persistent emergency snapshot can independently
restore the exact pre-restore local bytes while offline.

Automated status: Drop, harness, and Git workspace namespace tests cover
dry-run, create/replace/delete planning, SQLite refusal, Session Capsule
preservation, third-client convergence, Git branch/detached/unborn identity,
raw-index recovery, failed-commit automatic rollback, race refusal, and
explicit offline emergency rollback. The packaged Drop flow passed the real
Cloudflare/Daytona drill; see
[the executed report](uat/2026-09-07-in-place-restore-daytona.md). Real-version
harness execution remains required before the public recovery claim. The
packaged live workspace portion passed separately; see
[the workspace report](uat/2026-09-07-workspace-in-place-restore-daytona.md).

### UAT-09 Lost device and recovery

Create at least two independently authorized persistent devices and publish a
namespace at epoch one. Revoke one device, rotate from the remaining owner with
a new encrypted keyring kit, and publish changed data at epoch two. Verify a
second still-active device automatically unwraps its envelope. Attempt pull and
write from the revoked device, then enroll a clean replacement. First try the
epoch-one kit and confirm it fails closed; use the new kit and restore both
historical and current state. Also inject a connection loss after the live
rotation mutation and reconcile from the device envelope, then repeat with the
reconciliation endpoint unavailable and confirm the new kit is preserved.

Acceptance: the D1 epoch and envelope set advance atomically; no envelope exists
for the revoked device; its old key cannot decrypt epoch-two objects or commit
old-epoch state; active peers and the replacement converge; existing
capabilities are unusable; stale recovery does not become local authority; an
ambiguous result never deletes the candidate kit; recovery material is absent
from logs/output; pre-revocation local plaintext limitations are clearly
stated. Remove every disposable account, vault, object, token, and sandbox and
restore the production signup allowlist after the drill.

### UAT-10 Product isolation

On a machine with AgentStash and ClawStash fixtures installed, install, operate,
and uninstall Statecase while the other tools remain active.

Acceptance: Statecase never reads or modifies their configuration, processes,
repositories, credentials, services, or data; uninstall removes only
Statecase-owned artifacts.

### UAT-11 Harness upgrade incompatibility

Introduce a fixture representing an unknown native format and launch through
the shim.

Acceptance: harness still launches; unsafe sync for that category pauses with a
diagnostic; raw local state remains intact.

### UAT-12 Uninstall/bypass

Bypass each shim, stop/uninstall daemon and skills, then uninstall Statecase.

Acceptance: original harness commands and native state remain functional; only
Statecase-owned artifacts are removed.

## 17. Release acceptance

### Global instructions and memory — AD-CTX-001..009

See [ADR-0024](adr/0024-portable-instructions-and-memory.md) for the complete
test-ID contract. The deterministic suite covers registry/import closure,
file/tree/link/size boundaries, timestamp collisions, concurrent file creation,
encrypted two-device transfer, preview, deletion, conflicts, multi-file rollback
and historical restore under key epochs 1/2 with failed-publication recovery.
Authority cases include missing/append provenance, instruction tombstones and
future reserved versions, retained owner instructions, dishonest snapshots,
skipped parents, all pointer identity fields and older-server no-upload behavior.
The workerd capability scenario verifies replace denial and persisted append
provenance in namespace heads, immutable revisions and checkpoints.

Native AD-CTX-007 uses independent instruction markers never supplied in user
prompts. Fresh target requests must include the synchronized global content;
Codex must select AGENTS.override.md over AGENTS.md, and Claude must include
CLAUDE.md, its reviewed relative import and an unconditional global rule.
Unit negative controls reject missing markers, fallback content and markers
present only in tool metadata. Run native binaries only on disposable hosted
VMs. Local helper tests do not establish native behavior; record exact native
CI results separately. AD-CTX-008 workspace-memory, complete import syntax,
cross-host/live-Worker and mixed-client qualification remain required.

### Acceptance gates

RT-017 tracks unexpected background fixture service loss. Diagnostics must
distinguish a live supervisor from an exited process and report only allowlisted
exit/network/signal/category metadata. Negative controls include arbitrary
stderr content, large output, unknown signals/codes and spawn failure. A running
supervisor is not proof that its descendant Worker or service socket is healthy.
No retry, automatic backend restart, reduced idle window or skipped assertion
may turn a service-loss failure into a pass. Local repeats do not replace exact
candidate CI qualification or establish a cause for an earlier failure.

AD-MEM-001..010 in [ADR-0025](adr/0025-memory-identity-and-local-bindings.md)
track memory integration separately from global instructions. Binding and format
unit tests prove only their own boundaries, not native memory portability.

Engine qualification now exercises AD-MEM-002..006 with synthetic temporary
roots and an encrypted reference transport: differing local paths; canonical
identity descriptors; no-op/edit/delete/conflict; explicit scope-key denial and
read/append updates; exact historical and multi-checkpoint hydration; missing
mapping/namespace/payload before mutation; selection-only capsule refresh and
opaque retention roots; cross-epoch restore and failed-publication rollback.
Scanner tests bound files, bytes and directory enumeration, inject lost/changed
files and trees, and verify redacted failures and plaintext-buffer disposal.
Restore rejects a request that strips the internal native-memory policy marker.
These are local tests, not native recall, live GC, server-side revocation,
CLI enrollment or background/independent-host qualification.

The subsequent AD-MEM-007 CLI suite verifies local map/list/remove, required
confirmation vs dry-run, metadata-only output, idempotency and path rebind,
immutable identity, inverse Drop ownership rejection, unsafe enrollment refusal,
agent-driven selection while a synthetic activity marker exists, and stale
configuration-write refusal. Eight simultaneous config saves admit one writer.
The clean-installed package smoke executes memory selection/rebind/removal and
checks that the skill's memory reference is included. CLI reference-cloud tests
publish memory and stage only the requested memory/Drop while other configured
collections remain untouched. AD-MEM-010 local checks verify actual filesystem
notification from the external memory root, daemon root selection and generated
service permissions; they do not qualify missing-root startup, OS reboot, native
recall or the packaged/live cross-host workflow.

AD-MEM-008 additionally runs `npm run uat:native-claude -- --memory` with the
pinned Claude executable only inside a disposable GitHub runner VM. The drill
requires fresh source, target, return-recall, memory-disabled, worktree,
subdirectory and unrelated-repository session IDs;
startup index markers are independent of prompts and cannot be satisfied by
assistant/tool history or tool metadata. Topic markers must appear only after a
native Read; native Edit and Write update the selected memory. Encrypted
transfer/hydration moves exact bytes from the default source repository directory
to a different target custom root, preserving target-local settings, preview
non-mutation and unrelated project memory. Return transfer must be recalled by
another fresh native session. Worktree and subdirectory sessions must load the
repository's returned index, while an unrelated repository must load its own
index and exclude every selected-project marker. Evidence-guard unit tests include forbidden
markers, malformed requests and prompt/history contamination. CI execution and
its result must be recorded separately; this reference-backend test does not
qualify autonomous model generation, full precedence, subagents,
history-path localization or the independent-host packaged/cloud workflow.
Both the first four-session pass and the seven-session location-extension pass
are recorded in [the native report](uat/2026-09-08-native-claude-memory.md), with
candidate/job IDs and the reference-backend/native-location evidence boundaries.

AD-MEM-011 adds failing-first regressions for source absolute memory paths left
in restored tool inputs. Tests require exact portable/native/restaged bytes,
preserved prose/Write content/tool results, JSON argument and function envelopes,
safe directory/Unicode paths, source/target project checks, missing mappings,
traversal/encoded paths, unsupported opaque formats, bounded traversal, unbound
global sessions and plaintext-stage cleanup after refusal. A generic engine pull
with a missing memory binding must leave applied and native state untouched.
The extended native Claude drill must resume the original UUID, observe localized
historical memory tool arguments, preserve the old Read output and perform a new
native Read from the target memory directory. Both transfer directions must then
have a no-op canonical push. Relative/freeform and migration cases remain required.

The relative-reference AD-MEM-011 extension requires cwd changes across records,
native Claude user/assistant metadata, missing/malformed cwd refusal, absence of
process-cwd/prose inference, canonical parent-relative paths, noncanonical-path
denial, preserved authored content and resolved memory activity. The pinned
native fixture sends relative Read/Edit/Write paths and must verify those exact
relative arguments in source history before encrypted hydration, same-UUID
target resume, native Read and return/no-op checks. A fixture implementation or
prior absolute-path pass does not establish this new native result.

AD-MEM-011 return-baseline regressions compare the applied digest with the native
accepted prefix, not portable bytes. Exercise ordinary and buffered legacy first
publication, unchanged-source return, an edit injected during object upload, a
later complete edit and incomplete JSONL tails both before and after capture.
Uncaptured local work must produce a non-mutating conflict; restoring the exact
captured fixture bytes then permits return and a no-op push. The native driver
reports separate return publish/pull/no-op phases and fixed error classes, never
raw exceptions or transcript content. These diagnostics do not relax assertions.

AD-MEM-011 freeform cases require all four header operations, LF/CRLF, exact hunk
and trailing-whitespace retention, header lookalikes in content, source-relative
and absolute paths, missing cwd/bindings, wrong ownership, unsafe mapped headers,
late/repeated Move-to and malformed-envelope rejection before mapper invocation.
Streamed activity, localization, restaging and encrypted ordinary/legacy returns
must agree. The disposable native Codex drill must prove relative source patch
history, actual same-UUID resume with target-local memory headers, native target
patch execution, preview non-mutation, exact return and two no-op pushes. This
does not imply automatic native memory generation or workspace/Drop raw patch
conversion. Exact candidate CI evidence must be recorded separately.

AD-MEM-011 concurrent-return tests project only reviewed memory references to
logical identity while retaining complete-record order and occurrence counts.
Require both native branches after ordinary and raw-patch concurrent publication,
old applied markers until verified pull, preserved authored content, missing-
duplicate denial, invalid references even in unmatched remote suffixes and
incomplete-tail refusal. The native Codex fixture must resume the original UUID
on both homes before source hydration, merge, preserve both native contributions
exactly once, converge both peers and produce no-op pushes. This does not close
arbitrary active-writer races or historical/mixed-client migration.

A release candidate is rejected when:

- a critical/required test is skipped or flaky;
- convergence, integrity, tenant-isolation, key, or restore tests fail;
- UAT lacks recorded artifact versions and evidence;
- a plaintext canary appears in cloud storage or logs;
- any failure produces silent last-writer-wins behavior;
- supported migration or uninstall cannot be completed and rolled back;
- performance exceeds a target without an approved, time-bounded waiver.

UAT evidence records release SHA, package integrity, OS/filesystem, harness and
Git versions, API deployment/migration versions, scenario IDs, result, redacted
logs, and operator/reviewer sign-off.
