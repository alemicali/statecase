# Changelog

All notable changes to Statecase will be documented here.

## Unreleased

- Package the alpha CLI as a self-contained npm tarball with its canonical
  agent skill and runtime SQLite dependency.

- Established the standalone greenfield repository, product specification,
  threat model, TDD/UAT plan, and repository governance.
- Implemented the private manual-sync MVP: Cloudflare Worker/D1/R2/Durable
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
