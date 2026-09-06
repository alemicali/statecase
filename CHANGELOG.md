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
