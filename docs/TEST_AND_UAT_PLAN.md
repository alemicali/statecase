# Statecase TDD, verification, and UAT plan

Status: required delivery plan

Executed evidence: the
[2026-09-06 Daytona and Cloudflare product UAT](uat/2026-09-06-daytona-cloud.md)
passes the packaged CLI, real Codex/Claude shim, two-device authorization,
encrypted Drop round-trip, deletion, conflict, and snapshot subset of this
plan. The
[2026-09-07 Git-baseline Daytona UAT](uat/2026-09-07-git-baseline-daytona.md)
also qualifies explicit ask/auto policy and shallow-clone acquisition against
the live service. Native macOS/Linux service-manager, ARM64, WSL2, large-scale performance,
retention/GC, and destructive recovery drills remain open release gates.
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
- `CR-010`: revoked device cannot obtain newly wrapped keys.

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
  flow or returns `BASELINE_UNAVAILABLE` without partial apply; an unreachable
  later workspace rolls back earlier automatic checkouts and leaks no remote
  URL or credential-shaped diagnostic.
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
- `WS-023`: transcript lies about a path; filesystem/Git reconciliation remains
  authoritative.
- `WS-024`: optional OS activity events missing/reordered/duplicated do not
  affect capsule correctness.
- `WS-025`: applying the same capsule twice is idempotent.
- `WS-026`: baseline plus overlay produces the recorded final content digest.
- `WS-027`: a Session Capsule pins the exact harness, workspace, baseline, and
  Drop revisions observed at checkpoint time.
- `WS-028`: historical resume hydrates its recorded dependency closure even
  when workspace and Drop heads have advanced.
- `WS-029`: a missed filesystem event is recovered by final Git/index
  reconciliation and included in the overlay.
- `WS-030`: unchanged tracked reads record Git object IDs and upload no source
  bytes.
- `WS-031`: changed/untracked/Drop-backed reads pin content/revisions according
  to policy.
- `WS-032`: strict, warn, and best-effort hydration handle unresolved external
  dependencies exactly as documented.
- `WS-033`: local workspace capsule preview reports only bounded Git
  baseline/ref and overlay size/count metadata, performs no network or config
  mutation, emits no captured file bytes, and rejects identity-only mappings.

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
  required capability fails explicitly.
- `PR-015`: Worker logs contain no plaintext body or authorization material.

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

## 9. Daemon and shim tests

- `RT-001`: setup resolves the real harness binary and refuses recursion.
- `RT-002`: stdin/stdout/stderr, TTY dimensions, colors, and interactive input
  pass through unchanged.
- `RT-003`: SIGINT/SIGTERM/SIGHUP and terminal resize reach the child; exit code
  is preserved.
- `RT-004`: offline preflight follows policy and leaves a visible queued state.
- `RT-005`: final flush timeout does not alter the harness exit code or discard
  the journal.
- `RT-006`: crash/kill at every journal transition replays idempotently.
- `RT-007`: two daemons for one profile cannot run concurrently.
- `RT-008`: sleep/wake and network change trigger reconcile without a storm.
- `RT-009`: rapid file events debounce but the maximum publish deadline holds.
- `RT-010`: IDE launch without shim still synchronizes through daemon.
- `RT-011`: ephemeral `statecase run` needs no systemd/launchd.
- `RT-012`: uninstall removes only Statecase-owned shims/services and restores
  prior PATH behavior.

## 10. Backup, retention, and restore tests

- `BK-001`: every accepted commit references a readable immutable manifest.
- `BK-002`: hourly/daily/monthly retention selects deterministic checkpoints
  across DST, leap day, timezone changes, and clock skew.
- `BK-003`: protected snapshot survives normal retention.
- `BK-004`: garbage collection preserves every object reachable from head,
  retained snapshot, conflict, pending commit, and grace period.
- `BK-005`: concurrent snapshot creation and garbage collection cannot race.
- `BK-006`: dry-run lists exact creates/replaces/deletes and byte requirements.
- `BK-007`: restore refuses an active unsafe database or live harness target.
- `BK-008`: disk-full during staging leaves destination and applied revision
  unchanged.
- `BK-009`: restore validation failure rolls back and preserves emergency copy.
- `BK-010`: selective workspace/session/category restore cannot cross scope.
- `BK-011`: restoring a tombstone creates a new revision.
- `BK-012`: total cloud loss can be recovered from a separately exported,
  documented recovery artifact when that feature is enabled.

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
previously present object ID is uploaded. `PERF-002` and the literal 2-GiB
`PERF-003` run remain release acceptance tests. Automated file and two-device
tests cover suffix-only concurrent merge over a streamed common base and the
streaming supersequence acceptance check.

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
files; overlay contains changed/untracked content; dependency report is empty.

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

### UAT-08 Restore drill

Delete and corrupt selected local data, create later remote tombstones, then
restore a protected older snapshot first to staging and then in place.

Acceptance: dry-run is exact, validation passes, tombstoned data returns via a
new revision, and unrelated/current data is untouched.

### UAT-09 Lost device and recovery

Revoke a device, attempt remote access from it, enroll a clean replacement with
recovery material, and restore selected state.

Acceptance: revoked writes fail; replacement succeeds; recovery material is
not logged; pre-revocation local plaintext limitations are clearly stated.

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
