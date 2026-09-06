# Statecase product strategy

Status: approved product direction; implementation and release qualification in progress
Last updated: 2026-09-05
Owners: Statecase maintainers

## Executive decision

Statecase is a new, local-first, end-to-end encrypted synchronization and
recovery layer for agent harnesses, built from scratch in a standalone
repository.
The first supported sync adapters are OpenAI Codex and Claude Code, but the
product and protocol are not limited to coding agents.

Users keep launching the original `codex` and `claude` commands and the
harnesses keep reading and writing their native local files. Statecase runs
around them through transparent shims, a local daemon, and harness adapters.
The remote control plane runs on Cloudflare Workers using Hono, Durable
Objects, R2, and D1. No shared network filesystem and no permanently running
cloud VM are required.

The product category is **the encrypted Dropbox for agents**: the portability
layer that keeps each harness's operational context available wherever it runs.

Canonical value proposition:

> **Statecase — Take your agents anywhere. The encrypted Dropbox for agents:
> carry sessions, skills, context, and work in progress across every machine,
> so each agent picks up exactly where it left off.**

Statecase makes the agent's **operational context** portable. It does not move
the model provider, hosted model weights, or harness executable. A compatible
Codex or Claude installation attaches to the synchronized context and resumes
with the appropriate sessions, skills, settings, memory, workspace capsule,
and Drops.

## Problem

Coding-agent state is fragmented across machines and harness-specific paths.
It includes sessions, skills, configuration, memory, project metadata, and
occasionally credentials. Existing approaches do not satisfy the whole job:

- Git is excellent for source and curated text, but poor for large, frequently
  appended session files, secrets, generated state, and concurrent writers.
- NFS or another remote filesystem adds latency and availability to the hot
  path and is unsafe for several SQLite/WAL and append-heavy workloads.
- `rsync` and `rclone` copy files but do not understand session identity,
  partial JSONL records, logical workspaces, conflicts, or retention.
- Snapshot backup engines produce point-in-time recovery artifacts, not a
  multi-device synchronization protocol.
- Harness-native session storage is inconsistent across products and is not
  universally available to interactive CLIs.

Statecase therefore needs application-level synchronization, not merely file
replication.

## Product principles

1. **Harness transparency.** No fork or patch of Codex or Claude is required.
2. **Local-first operation.** A network outage must not stop normal agent use.
3. **Agent-native control.** Humans and agents use the same deterministic CLI;
   skills teach harnesses when and how to invoke it.
4. **End-to-end encryption.** Cloud infrastructure stores ciphertext and the
   minimum metadata required to coordinate sync.
5. **Logical identity.** Absolute home and workspace paths are device-local
   mappings, never global object identities.
6. **Safe concurrency.** Append-only data merges when safe; ambiguous state is
   preserved as a conflict or fork, never silently overwritten.
7. **Sync is not backup.** Current state may advance or delete; retained
   revisions and protected snapshots provide recovery.
8. **Least privilege.** Persistent devices, CI, and ephemeral sandboxes receive
   different, revocable scopes.
9. **Incremental transfer.** Immutable content-addressed chunks avoid moving
   multi-gigabyte histories repeatedly.
10. **Complete workspace continuity.** A resumable session includes its
    reproducible Git baseline and the non-reproducible working-tree overlay,
    not only the transcript.
11. **Observable and reversible.** Every material operation is inspectable,
    retryable, and restorable.

## Target users and jobs

### Individual developer with multiple persistent machines

The user works on a laptop and VPS. They want their global skills,
configuration, and appropriate project sessions available on both without
maintaining matching absolute paths.

### Developer using ephemeral sandboxes

The user creates short-lived Daytona-like environments. A scoped bootstrap
credential should hydrate only the requested workspace and safe global
configuration, then publish newly produced session state before termination.

### Agent-driven automation

An agent receives a task such as "attach to Statecase and recover the latest
context." A native skill detects whether Statecase is configured, invokes
machine-readable CLI commands, and never asks the model to inspect secret
values.

### Disaster recovery

A device is lost or corrupted. The user installs Statecase, enrolls a new
device using an existing trusted device or recovery material, previews a
restore, and materializes a chosen revision without overwriting unrelated
local data.

### User-defined synchronized material

The user selects one or more arbitrary local directories containing prompts,
notes, datasets, scripts, or other agent inputs. Statecase maps each directory
to a logical **Drop** and synchronizes it independently of harness-owned state.
Different machines may map the same Drop to different absolute paths.

## Experience: first use

On the first persistent device:

```bash
statecase login
statecase vault create personal
statecase setup --harness codex,claude
statecase daemon install
statecase sync
```

The flow creates an account session, a device identity, a vault, encryption
material, harness mappings, skills, shims, and a background service. It scans
and previews the selected categories before the first upload. Secrets are
excluded by default.

Project continuity is configured independently:

```bash
statecase workspace attach --auto --mode git-overlay
statecase drop add ~/agent-material --name agent-material
```

On an additional persistent device:

```bash
statecase login --device-name vps-01
statecase setup --vault personal --harness codex,claude
statecase sync --pull
statecase daemon install
```

The device is approved through a browser/device-code flow, another trusted
device, or recovery material. The user does not copy a raw vault key.

## Experience: steady state

The user continues to run:

```bash
codex
claude
```

The transparent shim performs a bounded preflight pull, launches the real
harness with inherited terminal and signal behavior, and requests a final
flush after the child exits. The daemon journals local changes, uploads safe
incremental data, polls for remote heads, applies compatible changes, and
retries after offline periods.

Manual control remains available:

```bash
statecase status
statecase sync
statecase pull
statecase push
statecase conflicts
statecase snapshot create --name before-upgrade
statecase restore --revision <revision>
```

## Experience: ephemeral environment

A trusted device or control panel creates a single-use capability:

```bash
statecase token create \
  --workspace github.com/alessio/polpo \
  --permissions read,append \
  --ttl 2h \
  --single-use
```

The secret manager injects it as `STATECASE_BOOTSTRAP_TOKEN`. The sandbox
runs:

```bash
statecase bootstrap --non-interactive
statecase run codex
```

The bootstrap token grants only the required workspace keys and categories.
Periodic publishing reduces data loss if the sandbox is killed before its
normal teardown hook.

## Product surface

### Local CLI and daemon

- interactive and non-interactive enrollment;
- harness discovery and adapter configuration;
- workspace attach/mapping;
- pull, push, two-way sync, status, diagnostics, and conflict resolution;
- revision, snapshot, restore, retention, and export;
- device and bootstrap-token management;
- daemon and transparent shim lifecycle;
- stable JSON output for skills and automation.
- Git-baseline workspace capsules containing dirty/staged/untracked/deleted
  state required to continue work;
- arbitrary user-selected synchronized roots called Drops.

### Agent skills

The initial distribution includes an Statecase skill for Codex and Claude.
It covers connect/bootstrap, status, workspace attachment, context hydration,
publish, snapshot, restore preview, and conflict reporting. Persistence never
depends on the model choosing to invoke a skill; shims and the daemon remain
the correctness layer.

OpenAI documents user-level Codex skills under `$HOME/.agents/skills` and
supports explicit or description-based invocation. Statecase follows those
native discovery mechanisms rather than injecting prompt text. See the
[official OpenAI skill documentation](https://learn.chatgpt.com/docs/build-skills).

### Cloud service

- Hono HTTP API on Cloudflare Workers;
- Durable Object coordinator per vault for ordered commits and leases;
- R2 for encrypted immutable chunks and manifests;
- D1 for accounts, devices, vault catalogue, tokens, audit summaries, and the
  optional control panel index;
- optional web control panel after the CLI protocol is stable.

### Optional control panel

The control panel is not required for initial-release correctness. When added, it manages
devices, bootstrap tokens, workspaces, sync health, retained snapshots, audit
events, and revocation. It must not display decrypted session contents unless
an explicitly designed client-side decryption experience is approved.

## Scope

### Initial release: sync foundation

- Linux and macOS persistent clients; Linux ephemeral containers.
- Node.js CLI and a new `statecase` package identity.
- Codex and Claude adapters.
- Sessions, skills, non-secret configuration, settings, and project metadata.
- Git workspace capsules: exact baseline revision plus staged, modified,
  deleted, mode, symlink, and selected untracked overlays.
- User-defined Drops with logical cross-device path mappings.
- Logical workspace identity and per-device path mappings.
- Local journal, incremental encrypted chunks, revision commits, tombstones,
  conflict preservation, and restore preview.
- Browser/device-code login plus scoped bootstrap tokens.
- Hono Worker, Durable Objects, R2, D1, and infrastructure configuration.
- Transparent shims, foreground `statecase run`, and Linux/macOS daemon.
- Statecase skills and stable JSON command contracts.
- Automatic retained revisions and manual protected snapshots.

### Next

- Windows native support beyond WSL.
- Claude SDK `SessionStore` integration for headless workloads.
- Web control panel.
- Direct presigned R2 transfer for high-volume clients.
- Additional harness adapters added to the Statecase registry.
- Organization sharing, policy enforcement, and SSO/workload identity.
- Selective client-side search/indexing across encrypted sessions.

### Explicit non-goals for the initial release

- Hosting or proxying model inference.
- Replacing Git hosting or synchronizing complete Git object databases. Git
  remains the source baseline; Statecase carries the continuity overlay.
- Mounting R2 as a live filesystem.
- Real-time collaborative editing of one session by multiple harness processes.
- Cloud-side plaintext indexing or semantic search.
- Automatically syncing harness authentication tokens or API keys.
- Guaranteeing zero data loss after uncatchable process/container termination;
  the target is bounded loss through frequent local journaling and publishing.

## Data categories and defaults

| Category | Persistent devices | Ephemeral default | Notes |
| --- | --- | --- | --- |
| sessions | on | selected workspace | append-aware |
| skills | on | read-only | global and workspace scoped |
| config | on, allowlisted | read-only | machine-specific fields filtered |
| settings | on, allowlisted | read-only | portable subset only |
| memory | opt-in | selected workspace | adapter-defined |
| workspace metadata | on | on | logical identity and baseline |
| workspace overlay | on | selected workspace | changes not reproducible from Git |
| user Drops | opt-in | explicitly scoped | arbitrary allowlisted roots |
| secrets/auth | off | prohibited | explicit secured vault only |
| caches/logs/binaries | off | off | rediscoverable or unsafe |

## Identity model

The same checkout may live at `/home/alessio/project`, `/srv/project`, or
`/workspace/project`. Statecase identifies it through a stable logical
`workspaceId`, preferably derived from a normalized Git remote plus optional
monorepo subpath. Non-Git folders require an explicit ID. Each device stores a
local `workspaceId -> absolutePath` mapping.

A session identity is scoped by:

```text
vault + harness + profile + workspaceId + nativeSessionId
```

Absolute paths may appear as local adapter metadata but never participate in
remote uniqueness or collision decisions.

## Synchronization and recovery model

Every accepted sync creates an immutable manifest revision. File deletions
advance the current head through tombstones but do not immediately erase old
objects. The default proposed retention is:

- 24 hourly checkpoints;
- 30 daily checkpoints;
- 12 monthly checkpoints;
- manual snapshots retained until explicitly removed;
- unreachable chunks collected only after retention and a 30-day grace period.

Restoring is always previewable. Restoring over active harness state requires
the harness to be stopped or the restore to target a staging directory.

## Workspace continuity model

A conversation alone is insufficient if it refers to code that exists only on
the originating machine. The recommended `git-overlay` mode stores:

- normalized repository identity and exact base commit;
- branch/detached-HEAD metadata;
- staged changes and index intent where portable;
- modified, deleted, renamed, executable-bit, and safe symlink state;
- selected untracked files, subject to ignore and secret policies;
- a working-set index of workspace-relative files read or written by the
  harness.

On another machine, Statecase verifies or obtains the Git baseline and applies
the encrypted overlay transactionally. It does not need to upload unchanged
tracked files: their content is reproducible from the pinned Git commit.

Each resumable checkpoint creates a **Session Capsule** linking the harness
session revision to the exact workspace capsule and Drop revisions it observed.
Hydration resolves and validates this dependency closure before resume. This is
what prevents a current session from being paired accidentally with newer,
older, or incomplete project files.

Read tracking is an optimization and completeness check, not the source of
truth. Agent adapters first extract file references from native session/tool
events and compare them with Git and the overlay. OS-level tracing is optional
because complete read interception is expensive, privacy-sensitive, and not
portable across Linux and macOS. An external read is never copied silently; the
user must add its root as a Drop or approve a rule.

At harness start, Statecase records the Git/index baseline. During execution it
maintains a cheap touched-path set from native events, transcripts, and file
watchers. At each checkpoint it reconciles that set with Git status so missed
write events cannot make the overlay incomplete. A tracked, unchanged read is
represented by its Git object identity and requires no upload; changed,
untracked, and Drop-backed reads are content-addressed and included by policy.

Non-Git directories can use explicit `mirror` mode. This is opt-in because it
may upload large or sensitive trees.

## Product name decision

The new product working name is **Statecase**: a case that carries an agent's
operational state between machines. It is intentionally independent of a
specific harness and does not include "agent" in the brand name.

The `statecase` npm name was preliminarily unclaimed when this decision was
made. Formal trademark, package, organization, and domain clearance remains a
pre-public-launch gate; the working name may still change without a product
data migration because no public release exists.

The one-liner leads with portability, uses Dropbox as the familiar analogy, and
immediately explains which parts of the operational context become available.
Formal trademark and domain clearance remains a launch gate; this is a product
recommendation, not a legal clearance or an implication of affiliation with
Dropbox.

The external brand uses **agents**, not **coding agents**. Codex and Claude are
the initial market wedge and adapter scope; future harnesses can reuse the same
vault, identity, Drop, Capsule, sync, and recovery primitives.

## Standalone greenfield repository

Statecase starts in a new standalone repository and npm-workspaces monorepo.
It does not copy, import, link, or depend on AgentStash, ClawStash, or their
Restic integration. This keeps backup and live synchronization as separate
products with separate trust boundaries, configuration, release cadence, and
failure modes.

Existing projects may inform product research, but code is adopted only later
through an explicit dependency or a provenance-reviewed port. The initial release contains
no legacy migration surface. This accepted decision is recorded in
[ADR-0001](adr/0001-standalone-greenfield-product.md).

## Initial Cloudflare topology

The initial release uses one of each required remote Cloudflare resource in the existing
Cloudflare account:

- one Worker running the Hono API;
- one R2 bucket for encrypted immutable payloads and manifests;
- one D1 database for control-plane metadata;
- one Durable Objects namespace, containing one logical coordinator instance
  per vault.

Local development uses Wrangler's local runtime and local stores. There is no
separate remote development or staging stack during release qualification.
Resource names do not encode lifecycle stage; versions and deployment metadata
do. A later staging/production split can be introduced without renaming
protocol identities or changing client-side vault IDs. This is accepted in
[ADR-0002](adr/0002-single-cloudflare-stack.md).

## Differentiation

Statecase is not a generic file-sync product. Its defensible layer is the
combination of:

- harness-specific safe readers and materializers;
- path-independent workspace and session identity;
- append-aware merge and conflict semantics;
- agent-native skills and machine-readable CLI;
- scoped hydration for ephemeral agents;
- E2EE synchronization plus retained recovery points.

## Success metrics

The initial release is successful when:

- setup-to-first-safe-sync succeeds in under five minutes for a normal profile;
- a no-change preflight completes with p95 under two seconds on a warm client;
- incremental sync transfers only changed chunks;
- interrupted uploads resume without corrupting local or remote state;
- all destructive restores require a preview and explicit confirmation;
- no plaintext session or secret payload reaches Cloudflare;
- a project can move between different absolute paths without duplicate or
  missing sessions;
- sandbox bootstrap and final publish can be performed with one scoped secret;
- every critical requirement has automated tests and a passing UAT scenario.

## Business and packaging direction

Keep the protocol, local CLI, adapters, and self-hostable Worker implementation
open source. A hosted service can monetize managed infrastructure, retention,
organization policy, audit, support, and the control panel. Pricing and final
license boundaries are intentionally not decided by this strategy and require
a separate business decision before a hosted public launch.

## Relationship to existing backup tools

AgentStash and ClawStash remain independent backup tools. Statecase neither
modifies their repositories nor reads their configuration during setup. A
future import tool would require its own ADR, threat-model update, and UAT; it
is not part of the initial release.

## Principal risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Native formats change | versioned adapters, fixture corpus, canary discovery |
| Live files are inconsistent | stable reads, append boundaries, WAL exclusion |
| Concurrent writers diverge | base revisions, leases, merge rules, preserved forks |
| Key loss | recovery material and multi-device key wrapping |
| Token theft in sandbox | short TTL, one use, workspace/category scope, revocation |
| Silent sync deletion | tombstones, retained manifests, delayed garbage collection |
| Worker/request limits | small streamed chunks; later direct R2 uploads |
| Shim breaks harness UX | captured real binary, recursion guard, TTY/signal tests, bypass |
| Cloud outage | local-first journal and retry |

## Product gates

The following gates must be passed in order:

1. Protocol and data-model review.
2. Cryptographic design review and threat-model sign-off.
3. Adapter fixture tests against supported Codex and Claude versions.
4. Single-device sync and deterministic restore.
5. Two-device concurrency and failure-injection suite.
6. Persistent-device UAT.
7. Ephemeral-sandbox UAT.
8. Isolation and clean-uninstall UAT.
9. Limited private beta with telemetry restricted to metadata.
10. Public launch only after recovery drills succeed.
