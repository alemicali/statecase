# Statecase design readiness review

Status: private foreground-sync alpha implemented and deployed; not ready for public
production launch
Last updated: 2026-09-06

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
- Cloud: for the MVP, deploy one remote Cloudflare stack in the existing
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
- Repository security availability: the private MVP repository's current
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
2. **Native Windows semantics** — deferred; WSL smoke support only for MVP.
3. **Hosted pricing, data-region, metadata retention, and legal terms** — blocks
   commercial launch, not OSS implementation.
4. **Trademark/domain clearance for Statecase** — blocks brand investment, not
   technical work.
5. **Control-panel decryption UX** — deferred; CLI is the MVP control plane.

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
logical workspace path rewriting, and modified/untracked Git overlay transfer.
The single Cloudflare MVP stack is provisioned and private-signup allowlisted.

The next foreground slice is implemented locally: `statecase run` supervises
unmodified Codex/Claude processes with inherited terminal and signals, bounded
preflight and final synchronization, periodic publishing, exact exit-code
preservation, and durable queued retry. Statecase-owned transparent shims are
atomically installed/verified/removed without overwriting unrelated binaries.
Remote deletions now use manifest tombstones, unhydrated namespace pushes fail
closed, and pull materialization rolls back as one transaction after injected
mid-apply failure. Deployment of this slice follows isolated Docker and remote
compatibility verification.

The persistent daemon core is also implemented locally with a single-profile
crash-recoverable lock, recursive filesystem hints, periodic source-of-truth
reconciliation, remote polling, serialized execution, bounded exponential
retry, no-op revision suppression, and owner-only Unix-socket status. Native
systemd/launchd installers and sleep/network lifecycle integration are still
required before background steady state is claimed.

Automated background steady state is not yet claimed. Persistent daemon/service
installation, safe automatic merge, exact Git index/baseline capsules, retained
snapshots/restore, scoped ephemeral bootstrap, device revocation/key rewrap,
and complete historical Session Capsules remain blocking work for a public or
unattended release.

The design is intentionally not called production-complete. Crypto selection,
identity provider, exact compatibility matrix, and legal/commercial decisions
remain explicit gates rather than hidden assumptions. Any new requirement that
changes trust boundaries, plaintext exposure, conflict semantics, or deletion
must update the strategy, implementation specification, threat model, and test
traceability before code merges.
