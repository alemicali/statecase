# Changelog

All notable changes to Statecase will be documented here.

## Unreleased

- Preserve explicitly selected macOS Keychain paths in launchd service
  definitions, independent of the interactive shell. Keep legacy service
  ownership checks and stop/uninstall behavior; reject malformed/ambiguous
  environment dictionaries. Added a pinned original Linux envelope-context
  regression to verify pre-macOS protected-file compatibility.

- Added explicit macOS Keychain credential protection with bounded stdin-only
  key storage, selected-keychain lookup isolation, authenticated backend identity
  and foreign-backend refusal. Existing Linux encrypted files remain compatible.
  Added boundary tests and a clean-package disposable macOS keychain CI drill,
  now passed independently from the launchd job. Reboot/default-keychain UI,
  recovery and independent review remain unqualified.

- Fixed native UAT driver startup outside the repository: Codex and Claude
  scenarios now resolve the installed SQLite dependency explicitly through a
  shared test-only builder. Added a failing-first external-directory load test
  that acquires a real native mutex. This does not change the distributed CLI
  or replace full native-session qualification.

- Fixed a reproduced double-owner race in stale profile-lock recovery. Daemon,
  restore and credential locks now hold a dedicated SQLite/kernel mutex for
  their lifetime and publish complete v2 owner metadata atomically. Added real
  SIGKILL tests with eight restart contenders and two interrupted recovery
  boundaries. Guard files persist locally and are excluded from Drop sync and
  workspace materialization. Stop older local writers before upgrading; OS
  reboot and exact-candidate native platform qualification remain gates.

- Added explicit Linux native credential protection: non-mutating status and
  preview, confirmed migration to a Secret Service-wrapped encrypted file,
  verified key read-back, atomic updates, stale-save refusal and encrypted
  logout. Existing/headless owner-only file profiles are not silently migrated.
  Added failure regressions for unsafe files/FIFOs, wrong keys, concurrent
  mutations, malformed documents, diagnostic redaction and migration failure.
  An isolated native/package drill and CI job exercise persistent keyring
  restart and unavailable-store preservation. macOS, OS reboot, recovery and
  independent review remain qualification gates.

- Qualified the recorded CLI package's Claude foreground shim/live-cloud round
  trip across two independent Daytona peers: distinct device enrollment, strict
  preview/hydration, original UUID/history, native Read/Edit/Write, shim final
  flush, and source file/session return. Exact-target account/R2/sandbox cleanup
  was verified. Hosted inference and background/native Codex parity remain open.

- Fixed agent-native skill placement for configured Claude roots: install,
  verification, and uninstall now use the adapter's `CLAUDE_CONFIG_DIR`
  resolution rather than always targeting the default home directory. Added
  absolute/relative/default and isolated-environment lifecycle regressions.

- Closed a case-variant bypass of reserved recovery artifacts: upper/mixed-case
  transaction names and parent components are now excluded from sync and
  rejected in workspace capsules. Failing-first tests demonstrated unintended
  Drop publication and accepted incoming workspace writes before the fix.

- Qualified native Claude Code 2.1.263 Read/Edit/Write and original-UUID resume
  after encrypted engine transfer into a fresh home/different Git checkout,
  including exact baseline, untracked content, non-mutating hydration preview,
  original history, and return sync. Added a repeatable isolated native CI drill.
  Reference storage and deterministic loopback model responses do not qualify
  packaged/live-cloud cross-host use, hosted inference, or interactive pickers.

- Rejected Git metadata paths (including `.GIT` casing) and reserved recovery
  artifact paths inside workspace capsules. Added failing-first regressions
  proving a valid overlay must not overwrite `.git/config` or recovery files.

- Hardened managed workspace rollback against independent source/target branch
  advances and HEAD changes; branch mutations now use expected-value Git
  updates. Added creation/deletion, detached/unborn, and foreign-ref-lock tests.
- Fixed destructive rollback interference: retain a newer local file and its
  available original backup when exact restoration is unsafe. Added post-install
  write/delete/type-change tests and excluded transaction recovery artifacts
  from normal synchronization. Persistent crash recovery is still unqualified.

- Added an unqualified managed-workspace return-sync candidate (WS-034):
  authenticate the last-applied capsule before advancing a Git-dirty checkout,
  stage index updates separately, retain Git lock ownership, and guard planned
  targets against editor mutations before commit. Added preview, rollback,
  genuine-conflict, missing/corrupt-history, and lock/collision regressions.
  The native Codex engine-level return-sync rerun passed in a fresh Daytona
  sandbox. Packaged/live cross-host and remaining ADR-0020 release gates remain open.

- Fixed a CWD-dependent session normalization defect: running sync inside a
  mapped workspace could rewrite native record types, model names, and prose
  as workspace URIs. Only absolute path values are now portabilized. Added a
  failing-first regression and extended native UAT to sync from each mapped
  checkout and return the resumed work to its origin.
- Qualified native Codex 0.153.4 session-ID resume after encrypted engine
  transfer to a fresh home, SQLite root, and differently mapped Git workspace
  in Daytona, using a deterministic loopback provider. Added a reproducible
  native-harness CI drill. Fixed native freeform `apply_patch` dependency
  extraction; patch body prose and incomplete envelopes do not become paths.
  This is not yet packaged/live-cloud, cross-host, Claude, or hosted-model
  resume qualification; opaque shell reads remain a coverage limitation.
- Qualified the packaged native Linux/live Cloudflare background path: real
  systemd automatic restarts, interrupted-upload journal replay, offline and
  disjoint convergence, deletion, and idle no-op behavior. The opt-in UAT driver
  preserves its fully local default and requires explicit live scope/cleanup
  parameters. Temporary signup access and fixture D1/R2 data were removed.
- Added authenticated multi-process background UAT against isolated local
  workerd/D1/R2: automatic bidirectional Drop sync, interrupted object upload,
  durable journal replay after SIGKILL, offline restart, disjoint convergence,
  deletion propagation, and 45-second idle no-op verification. A dedicated CI
  job runs this without external credentials or real harness directories.
- Added profile-safe `daemon start` / `daemon stop`, idempotent service startup,
  and manager-loaded definition checks. Installation/removal now refuse another
  profile's service; uninstall verifies ownership before stopping anything.
  Linux CLI lifecycle and profile-isolation UAT passed. Added an isolated real
  launchd CI job; the lifecycle passed on macOS 26.6.2 arm64 / Node 24.20.0.
- Pinned the installing Node interpreter in Linux/macOS service definitions,
  preserved literal systemd environment-like paths, and rejected path control
  characters. Qualified real systemd-user start/stop, filesystem notifications,
  private IPC, duplicate-writer denial, SIGKILL recovery, and temporary-service
  cleanup using isolated unauthenticated fixtures. macOS and authenticated
  background synchronization remain separate release gates.
- Removed a CI fixture race: Git overlay tests now clone their source baseline
  instead of assuming independently created commits have identical timestamps
  and object IDs. Baseline mismatch enforcement is unchanged.
- Qualified packaged key rotation and recovery on Daytona against live
  Cloudflare: two successive rotations, offline epoch catch-up, revoked device
  and scoped-session denial, stale-kit rejection before membership, current-kit
  enrollment, scoped reissuance, and cross-epoch historical Drop restore. Fixed
  the remote D1 trigger parser incompatibility found during migration; the
  equivalent predicates now use `SELECT RAISE(...) WHERE ...`.
- Made offline vault-key history ingestion atomic: validate and authenticate the
  entire contiguous history before replacing local credentials. Commands use
  the authoritative current keyring rather than a potentially stale legacy
  alias, wipe owned root-key buffers on early failures, and reconcile a lost
  rotation response even after a later rotation has committed. Historical
  rekey and streaming append merge now release derived-key buffers on download
  and cleanup failures; failed input cleanup also releases an unclaimed merged
  plaintext stage without advancing the remote revision.
- Added post-revocation cryptographic key rotation with fresh monotonic vault
  key epochs, device-local X25519 exchange identities, sealed envelopes for the
  exact active-member set, transactional D1 recipient enforcement, old-epoch
  and legacy-write rejection, and automatic capability invalidation. Full-key
  clients retain authenticated historical keyrings, ingest missing envelopes
  sequentially, force a namespace snapshot across epoch boundaries, and reject
  incomplete histories. Version-two recovery kits carry every required epoch
  and reject stale replacement enrollment. The CLI writes recovery material
  before mutation, cryptographically reconciles lost successful responses, and
  preserves the candidate kit whenever the remote outcome remains unknown.
  Rotation and commit decisions now share the vault coordinator, with a
  persistent minimum epoch fencing late requests and ambiguous D1 completion.
  Capability creation validates its epoch and issuer transactionally; registered
  device exchange keys cannot be silently replaced. Cross-epoch offline merge
  compares authenticated content rather than ciphertext identities, and
  historical Drop/harness restore re-encrypts entries while preserving pins.
  Replacement enrollment now binds the recovery epoch transactionally and
  rejects stale kits before adding any vault membership.
- Added forward-forking in-place historical restore for full-key, two-way Drop,
  stopped Codex/Claude mappings, and exact Git workspaces. Restore now excludes daemon/harness
  writers, refuses SQLite/WAL/SHM targets, protects the current cloud head,
  persists an exact owner-only local emergency snapshot, validates the applied
  adapter state, rolls back on optimistic-commit failure, and publishes a new
  revision without rewinding shared history. Workspace recovery additionally
  preserves HEAD/ref identity, the raw Git index, and affected worktree bytes;
  dirty, detached, unborn, and missing-baseline paths are covered, while
  initialized submodules fail closed. An explicit offline `emergency rollback`
  command restores the pre-restore local state. The packaged Drop path passed
  a two-device Daytona drill against the live Cloudflare stack. The packaged
  workspace path subsequently passed exact branch/HEAD/index/worktree restore,
  independent-clone convergence, and offline rollback in Daytona. That drill
  also found and fixed ordinary pulls leaving a fetched baseline detached
  instead of restoring the authenticated symbolic branch identity.
- Qualified bounded multi-gigabyte session portability against the live
  Cloudflare service in Daytona: a 2,147,483,737-byte Codex JSONL round trip,
  two bounded tail uploads, deterministic concurrent append merge, and
  convergence on both devices' native paths.
- Completed multi-revision Session Capsule hydration. Harness, workspace, and
  Drop namespaces are resolved from their independently pinned encrypted
  revision chains, validated before mutation, and applied in one atomic local
  transaction; dry-run and missing-object failure remain non-mutating.
- Added production retention and reachability garbage collection for protocol
  1.1 namespace objects: deterministic 24-hour/30-day/12-month UTC checkpoints,
  protected snapshots, recursive Session Capsule pins, append-chain traversal,
  a 30-day grace period, conservative legacy migration, Durable Object commit
  exclusion, owner CLI preview/collection, daily Cloudflare cron execution,
  and real workerd R2 list/delete verification.
- Added bounded-memory session transfer for Codex and Claude JSONL: secure
  record-by-record staging, incremental keyed digests, deterministic 4 MiB
  record-aware chunks, manifest chunking descriptors, one-envelope-at-a-time
  encryption/decryption, atomic file-backed installation, and direct protocol
  1.1 bootstrap for new vaults. Appends no longer upload content-addressed
  chunks already present in the authenticated remote manifest. Legacy 1.0
  heads remain readable and migratable. Plaintext staging now checks available
  temporary-disk capacity, including a safety reserve, before allocation, and
  safely recreates ephemeral temporary roots that disappear when empty.
- Made same-session concurrent append merge independent of common-history size:
  the client verifies the base and both prefixes as streams, retains only
  bounded concurrent suffixes, writes the merged result to secure staging, and
  verifies the subsequent pull as a record stream.
- Added deterministic full-key client merge for concurrent complete-record
  appends to the same portable Codex or Claude JSONL session. The merge requires
  a byte-identical accepted prefix, preserves both branch orders, deduplicates
  canonical record occurrences, rebuilds Session Capsule activity, and keeps
  the publisher unapplied until a verified pull. Rewrites, malformed/incomplete
  records, incompatible order, scoped clients, and oversized inputs fail closed.
- Added local-only native session bindings so merged or hydrated portable
  sessions return to each device's existing harness path instead of creating a
  divergent canonical copy. Fresh devices bind the canonical fallback;
  supervised flush, hydration, deletion, dry-run, traversal, and destination
  collision behavior are covered by regression tests.
- Package the CLI as a self-contained npm tarball with its canonical
  agent skill and runtime SQLite dependency.

- Established the standalone greenfield repository, product specification,
  threat model, TDD/UAT plan, and repository governance.
- Implemented the initial manual-sync release: Cloudflare Worker/D1/R2/Durable
  Objects, Better Auth device flow, E2EE object protocol, hybrid chunking,
  local journal, Codex/Claude adapters, Drops, logical workspace path rewriting,
  Git working overlays, recovery kits, CLI, and agent-native skill.
- Added isolated workerd and Docker verification, paranoid crypto/path tests,
  and a two-machine CLI UAT fixture.
- Added supervised foreground `statecase run`, crash-safe queued reconciliation,
  transparent harness shims with safe bypass/uninstall, deletion tombstones,
  unhydrated-push protection, and rollback-safe filesystem materialization.
- Added the persistent daemon core with an exclusive recoverable profile lock,
  filesystem hints, remote polling, maximum reconciliation intervals,
  serialized jittered retry, owner-only local IPC status, and no-op revision
  suppression.
- Added atomically managed systemd-user and macOS LaunchAgent definitions,
  hardened service settings, explicit activation, and ownership-safe uninstall.
- Added encrypted exact Git workspace capsules that reproduce staged and
  unstaged variants independently, additions, deletions, binary/empty files,
  executable modes, safe relative symlinks, unborn/detached repositories, and
  staged gitlinks without transferring `.git` or nested repositories. Pulls
  validate capsule structure, object IDs, modes, paths, byte limits, and
  destination cleanliness before mutation, with index/filesystem rollback.
- Added explicit `git-overlay` and `metadata-only` workspace attachment modes;
  Git mode now fails at setup instead of failing later during synchronization.
- Added device-local `workspace move` and `workspace detach` lifecycle
  commands. Neither command moves or deletes files or cloud state; changed-path
  bindings clear stale applied markers and path collisions fail without
  modifying configuration.
- Completed the Drop CLI lifecycle with `drop remove` and remote-aware `drop
  status`. Removal is local-only, remapping invalidates stale applied state,
  invalid modes fail before configuration mutation, and scoped clients report
  unauthorized namespaces without presenting them as absent.
- Added `workspace capsule <id>` as an offline, non-mutating Git overlay
  preview. Its stable output contains baseline/ref and aggregate counts/sizes,
  never captured file bytes; metadata-only workspaces fail explicitly.
- Added per-device `ask|auto|never` Git baseline acquisition. Auto mode obtains
  missing commits from the checkout's existing `origin` with bounded,
  non-interactive system Git; shallow clones are supported, raw remote errors
  are redacted, and multi-workspace acquisition rolls back atomically.
- Added fail-closed Git LFS pointer diagnostics on capture and hydration. Missing
  materialized content is reported by logical path, while encrypted overlay
  replacements and deletions remain portable without synchronizing LFS
  credentials. Explicit auto policy now tries the device-local LFS cache, then
  fetches the exact baseline from the existing origin with bounded,
  non-interactive system Git LFS; size/SHA-256 verification, redacted failures,
  and transactional pointer restoration prevent partial or corrupt hydration.
- Added stable installation identities, server-side auth-session binding,
  account device listing, and explicit device revocation. Revocation atomically
  disables vault memberships and every bound login session; a revoked session
  cannot evade the decision by registering a different device ID.
- Added durable addressable revision records and protected named snapshots in
  each vault coordinator, with idempotent creation, owner-only deletion, CLI
  management, and selective historical restore into an explicit staging
  target. Historical materialization leaves the remote head unchanged and uses
  the same integrity, path, conflict, and transaction checks as normal pull.
- Added deterministic three-way namespace merging for offline writers:
  disjoint and identical edits converge, one-sided changes win over their known
  base, same-path and modify/delete divergence remains explicit, and workspace
  capsules merge atomically. Local state is not falsely marked applied when a
  merge retained remote content that still needs hydration. Append-only
  mappings reject overwrite, deletion, and tombstone resurrection.
- Added explicit local conflict resolution guarded by a protected snapshot and
  an expected-head check, preventing a race from overwriting an unprotected
  newer revision.
- Added encrypted immutable Session Capsules that bind changed native sessions
  to exact harness, Git baseline, workspace-overlay, and Drop revisions.
  Structured tool-event activity ignores prompt prose; excluded, ignored, and
  external files remain explicit unresolved dependencies instead of being
  silently copied. `workspace dependencies` inspects the closure and
  `workspace hydrate` restores its historical revision with strict, warning,
  or explicitly accepted best-effort behavior. The agent-native skill now uses
  this resume workflow.
- Added the protocol 1.1 server foundation for real ephemeral isolation:
  namespace-qualified encrypted R2 objects, atomically committed per-namespace
  heads, disjoint-writer concurrency, and blinded append-identity enforcement.
  Added D1-backed, single-use bootstrap grants with separately hashed access
  credentials, 24-hour maximum expiry, explicit read/append namespace scopes,
  secrets exclusion, revocation, creator-device cascading revocation, and
  denial of legacy full-vault endpoints. A real workerd test covers concurrent
  redemption, scoped R2/commit access, escalation attempts, and revocation.
- Replaced the R2 upload transform with an 8 MiB bounded read so conditional
  puts have the known length required by the real Cloudflare runtime.
- Added production client support for scoped capabilities: protected one-time
  bootstrap files, client-encrypted envelopes containing only explicitly
  granted namespace keys, redacted token create/list/revoke/bootstrap CLI
  commands, scoped credentials with no vault root, namespace-qualified object
  transfer, and fail-closed scope/expiry checks.
- Added encrypted namespace snapshot/delta manifests and immutable namespace
  revision pointers. Persistent writers migrate the legacy head into physical
  namespace mirrors; scoped read+append clients publish patch deltas, readers
  reconstruct bounded parent chains, and persistent devices reconcile sandbox
  work without granting legacy vault-wide access.
- Extended protected snapshots and historical restore to protocol 1.1 global
  scoped revisions, so conflict checkpoints and restore targets protect the
  authoritative namespace heads rather than the migration-only legacy head.
