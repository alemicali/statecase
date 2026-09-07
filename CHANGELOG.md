# Changelog

All notable changes to Statecase will be documented here.

## Unreleased

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
