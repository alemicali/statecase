# Changelog

All notable changes to Statecase will be documented here.

## Unreleased

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
