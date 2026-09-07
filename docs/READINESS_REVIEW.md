# Statecase design readiness review

Status: foreground sync implemented and deployed; release qualification in progress; not ready for public
production launch
Last updated: 2026-09-07

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
uninstall semantics; actual Linux/macOS lifecycle UAT plus sleep/network-change
integration are still required before background steady state is claimed.

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
session fail. Cryptographic key rewrapping after revocation remains a separate
release gate because already-decrypted data cannot be remotely withdrawn.

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
Bounded-memory push/pull is now implemented for both workspace-bound and
unbound harness JSONL. It stages records securely, hashes incrementally,
encrypts/decrypts one 4 MiB object at a time, installs from a verified staged
file, and skips remote content-addressed chunks during append. Automated
multi-chunk transfer and paranoid integrity cases are green. The literal 2-GiB
acceptance run remains outstanding. Concurrent append merge now validates and
copies common history as a stream, retains only bounded branch suffixes, emits
file-backed staging, and verifies the accepting pull record by record. All new
plaintext staging paths preflight available temporary-disk capacity with a
safety reserve and retain fail-clean semantics if capacity later changes.

Automated background steady state is not yet claimed. Real-OS daemon/service
UAT, scaled 2-GiB streaming acceptance, automatic retention/in-place restore,
post-revocation key rewrap, and complete historical Session Capsules remain
blocking work for a public or unattended release.

The design is intentionally not called production-complete. Crypto selection,
identity provider, exact compatibility matrix, and legal/commercial decisions
remain explicit gates rather than hidden assumptions. Any new requirement that
changes trust boundaries, plaintext exposure, conflict semantics, or deletion
must update the strategy, implementation specification, threat model, and test
traceability before code merges.
