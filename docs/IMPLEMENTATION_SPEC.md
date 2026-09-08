# Statecase synchronization implementation specification

Status: normative design; implementation and release qualification in progress
Last updated: 2026-09-07
Related: [Product strategy](./PRODUCT_STRATEGY.md),
[Test and UAT plan](./TEST_AND_UAT_PLAN.md),
[Threat model](./THREAT_MODEL.md)

## 1. Normative language and current-state warning

`MUST`, `MUST NOT`, `SHOULD`, and `MAY` are normative. This document describes
the target architecture. The current implementation provides the encrypted
manual CLI and supervised foreground vertical slices plus its single
Cloudflare stack. Foreground `statecase run`, safe shims, tombstone propagation,
transactional apply, the persistent daemon core, and native systemd/launchd
service definitions are implemented. Exact Git index/worktree capsules are
implemented for ordinary files, safe symlinks, unborn/detached repositories,
and uninitialized gitlinks. Durable revision pointers, protected snapshots,
selective staging restore, and full-key in-place restore for two-way Drops and
stopped Codex/Claude mappings are implemented. Content-addressed
three-way merge handles disjoint/identical namespace changes and preserves
same-path conflicts; workspace transports are atomic and append-only mappings
cannot mutate prior paths. Immutable Session Capsules and atomic multi-revision
historical closure hydration are implemented. Protocol 1.1 provides namespace-isolated R2
objects, immutable per-namespace revision chains, atomic namespace heads,
single-use scoped capability grants, client-encrypted scope-key bootstrap, and
rootless read+append synchronization. Full-key clients now deterministically
merge bounded, complete-record same-session JSONL appends and rebuild their
Session Capsule activity closure; rewrites and incompatible order fail closed.
UTC hourly/daily/monthly retention and namespace-object reachability GC are
implemented with protected-snapshot, Session Capsule, append-parent, grace,
and conservative migration roots. Full-key historical restore now also covers
exact Git workspaces. Sections covering safe parsed text merge and initialized
submodule hydration remain target requirements, not current claims.

Persistent device identities, auth-session binding, device enumeration, and
server-side revocation are implemented. Revocation blocks new service access
and membership use but cannot erase locally decrypted data. Monotonic vault-key
epochs, exact active-device sealed-box rewrap, old-epoch write rejection,
capability invalidation, sequential active-device refresh, and encrypted
multi-epoch recovery kits are implemented as specified by ADR-0019.

## 2. System boundaries

```text
unmodified harness
  -> native local state
  -> adapter + local journal
  -> chunk/compress/encrypt
  -> HTTPS API
  -> Hono Worker
       -> Vault Durable Object: ordered metadata decisions
       -> R2: encrypted immutable objects/manifests
       -> D1: identity/catalogue/audit metadata
```

The CLI MUST perform discovery, normalization, chunking, compression,
encryption, decryption, merge, and native materialization locally. The Worker
MUST NOT require plaintext agent content. Git object databases remain outside
the sync payload; a pinned Git baseline and encrypted working-tree overlay are
part of workspace continuity.

## 3. Target repository layout

The standalone repository uses this target layout:

```text
apps/
  cli/                       public statecase executable
  daemon/                    background and foreground supervisor
  cloud/                     Hono Worker and Durable Object exports
  dashboard/                 deferred web control panel
packages/
  core/                      domain model and sync engine
  protocol/                  schemas, errors, compatibility versions
  crypto/                    key hierarchy and object envelopes
  client/                    HTTP client and retry/idempotency
  storage-local/             journal, cache, materialization transactions
  adapters/
    codex/
    claude/
  workspace/                 Git baselines, overlays, activity index
  drops/                     arbitrary synchronized-root semantics
skills/
  statecase/                canonical open agent skill
fixtures/
  codex/
  claude/
docs/
  adr/
```

No package may import from an app. `protocol` and `crypto` MUST be independent
of Commander, Hono, Cloudflare bindings, and harness adapters.

## 4. Deployable components

### 4.1 CLI

The CLI is the sole stable automation interface. It MUST:

- support human output and `--json` output with versioned schemas;
- return documented exit codes;
- never print secrets, wrapped keys, authorization headers, or plaintext
  session contents by default;
- work interactively and with `--non-interactive`;
- use atomic local writes and a durable operation journal;
- expose dry-run/preview for destructive operations.

### 4.2 Daemon

Persistent installs use a launchd user agent on macOS and a systemd user
service on Linux. The daemon MUST:

- acquire one per-profile lock;
- consume filesystem events as hints, not as the source of truth;
- periodically reconcile all configured roots;
- write changes to the local journal before acknowledging them;
- debounce rapid writes and apply a maximum publish interval;
- back off with jitter after network failures;
- wake and reconcile after sleep;
- expose a local status endpoint or IPC channel without opening a public port.

Native service definitions invoke the installing `process.execPath` explicitly
before the CLI entrypoint. They do not assume that a GUI/user service manager
loads a login-shell PATH. Definition paths reject ASCII controls; systemd
specifier escaping and disabled ExecStart environment expansion preserve
literal `%` and `${...}` in local paths. After replacing/removing the pinned
Node runtime, reinstall the service. Linux native lifecycle evidence is recorded
in `uat/2026-09-08-native-systemd.md`; macOS 26.6.2 arm64 lifecycle evidence is
in `uat/2026-09-08-native-launchd.md`. Neither qualifies machine reboot/sleep
or authenticated background convergence.

`daemon start|stop` MUST verify the installed Statecase marker and profile
binding before invoking a manager. A loaded manager definition MUST resolve to
the expected file. One native service slot exists per OS user; changing
STATECASE_HOME does not authorize replacing/stopping another profile's slot.
Repeated start must not kill a healthy writer. Linux stop preserves its enabled
state; launchd stop unloads the job to defeat KeepAlive. Unknown inspection
errors never count as an absent job. JSON returns `action`, `platform`, and
`requested: true`; callers use `daemon status` to check readiness separately.

Proposed defaults: 2-second debounce, 30-second maximum push interval,
20-second remote-head poll, and exponential retry from 1 second to 5 minutes.
All are configurable.

### 4.3 Transparent shims

`statecase setup --transparent` installs `codex` and `claude` shims earlier in
`PATH`. Setup records the resolved real executable by device and verifies that
it does not point back to the shim.

The shim MUST:

1. identify profile, harness, current path, and logical workspace;
2. request a bounded preflight pull from the daemon, or run one in-process;
3. continue offline according to policy if the service is unavailable;
4. spawn the real child with inherited stdin/stdout/stderr and terminal mode;
5. forward signals and preserve the child's exit status;
6. keep periodic sync active while the child runs;
7. request a bounded final flush;
8. preserve unsent journal entries if flush fails.

It MUST set a recursion guard and provide `statecase bypass <harness>` and
`statecase which <harness>`. It MUST NOT mutate harness arguments except when
an explicit adapter policy requires an environment override.

### 4.4 Cloud API

The initial remote deployment contains exactly one Cloudflare Worker, one R2
bucket, one D1 database, and one Durable Objects namespace. The Worker hosts a
Hono application. Hono handles routing,
middleware, authentication, request validation, error mapping, and API
documentation. The CLI communicates through ordinary HTTPS. Hono RPC MAY be
used by the TypeScript client, but the wire protocol MUST remain documented
HTTP/JSON so another client language can be implemented.

There is no remote staging environment during initial release qualification. Development and automated
tests use Wrangler/local emulation; the single remote stack is treated as the
allowlisted release environment. Resource names do not encode release stage;
artifact versions and deployment metadata do. Configuration MUST keep binding
names and resource IDs environment-driven so adding separate
staging and production stacks later requires no protocol or persisted-data
format change. See
[ADR-0002](adr/0002-single-cloudflare-stack.md).

Worker bindings:

```ts
type Env = {
  BLOBS: R2Bucket;
  VAULTS: DurableObjectNamespace<VaultCoordinator>;
  DB: D1Database;
  STATECASE_GC_GRACE_DAYS: string;
}
```

The Worker streams encrypted object bodies to R2 and MUST NOT buffer complete
large files. Initial object chunks SHOULD be 4 MiB, configurable up to 8 MiB.
Later versions MAY issue scoped presigned R2 transfers.

Hono officially supports Cloudflare Workers and a typed RPC client:
[Workers guide](https://hono.dev/docs/getting-started/cloudflare-workers),
[RPC guide](https://hono.dev/docs/guides/rpc).

### 4.5 Vault Durable Object

There is one logical Durable Object per `vaultId`. It serializes:

- head comparison and commit;
- idempotency decisions;
- short session leases;
- conflict/fork registration;
- retention checkpoint advancement;
- garbage-collection eligibility.

The Worker SHOULD invoke typed Durable Object RPC methods, not run a second
Hono router inside the object. Cloudflare recommends RPC for new compatible
projects: [Durable Object invocation](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/).

### 4.6 R2

R2 stores only encrypted immutable objects and encrypted manifests. Proposed
keys:

```text
v1/vaults/<vaultId>/objects/<objectId-prefix>/<objectId>
v1/vaults/<vaultId>/manifests/<revisionId>
v1/vaults/<vaultId>/snapshots/<snapshotId>
v1/vaults/<vaultId>/quarantine/<objectId>
```

Object creation MUST be conditional. Re-uploading an existing object is an
idempotent success after metadata validation. Mutable `latest.json` files are
not authoritative; the Durable Object owns the head.

### 4.7 D1

D1 stores small queryable control-plane records, never chunks, session bodies,
or decrypted manifests. Initial tables:

```text
accounts(id, created_at, status)
devices(id, account_id, name, public_signing_key, public_exchange_key,
        status, created_at, last_seen_at)
vaults(id, account_id, name, coordinator_name, key_epoch, created_at, status)
vault_members(vault_id, device_id, role, wrapped_key_ref, enrolled_key_epoch,
              created_at, revoked_at)
vault_key_envelopes(vault_id, key_epoch, device_id, envelope,
                    created_by_device_id, created_at)
tokens(id, account_id, device_id, token_hash, scopes_json, expires_at,
       single_use, redeemed_at, revoked_at)
workspaces(vault_id, id, display_name, canonical_remote, created_at)
audit_events(id, account_id, device_id, action, target_type, target_id,
             outcome, metadata_json, created_at)
```

All tenant queries MUST include the account/vault boundary. Raw bearer tokens
MUST never be stored; store a slow or keyed hash appropriate to token type.

## 5. Domain model and identifiers

Identifiers are random UUIDv7/ULID-style opaque strings unless explicitly
content-addressed. They MUST not expose local paths or Git credentials.

- `accountId`: service tenancy.
- `deviceId`: one installation identity, revocable.
- `vaultId`: encryption and synchronization boundary.
- `profileId`: logical harness profile within a vault.
- `workspaceId`: stable project identity independent of local path.
- `mappingId`: device-local workspace-to-path association.
- `dropId`: stable arbitrary synchronized-root identity.
- `nativeSessionId`: ID assigned by the harness where available.
- `sessionKey`: `(vault, harness, profile, workspace, nativeSessionId)`.
- `sessionCapsuleId`: immutable dependency closure for a resumable checkpoint.
- `revisionId`: immutable committed manifest revision.
- `objectId`: keyed digest of canonical plaintext chunk plus format domain.
- `snapshotId`: retained pointer to a revision.
- `operationId`: client-generated idempotency key.

### 5.1 Workspace resolution

Resolution precedence:

1. explicit `STATECASE_WORKSPACE_ID`;
2. stored mapping for the current path or an ancestor;
3. normalized Git remote plus optional monorepo relative root;
4. explicit user-created identity for a non-Git directory;
5. unbound local workspace; no remote session merge until attached.

Git normalization removes credentials, protocol differences, a trailing
`.git`, case differences in the host, and insignificant trailing slashes. SSH
and HTTPS URLs for the same host/owner/repository resolve identically. Forks
with distinct owner paths remain distinct unless explicitly aliased.

Moving a checkout updates only the local mapping. Cloning the same repository
twice on one device requires an explicit mapping choice or distinct worktree
identity to prevent accidental concurrent use.

#### 5.1.1 Device-local native session binding

The remote identity of a portable session is its harness namespace plus logical
`portable-sessions/<workspaceId>/<nativeSessionId>.jsonl` path. Its native
filesystem location is not part of that identity. Each installation maintains
a local-only binding from that remote identity to a validated relative path
inside the mapped harness root.

A successful non-dry-run push records the native relative path that was scanned.
A pull consults an existing binding before materialization. On a device without
one, the adapter chooses its deterministic canonical destination and records
that choice only after the complete materialization transaction succeeds.
Hydration and supervised final flushes persist the same binding. A remote or
successfully published local deletion removes it.

Bindings MUST never enter manifests, object IDs, Session Capsules, API payloads,
or portable configuration. The relative path MUST remain inside its current
harness root and classify as a native session for that adapter; its basename
MUST match the portable native session ID. Multiple logical entries resolving
to one local path MUST fail before filesystem mutation. Applied content digests
remain keyed by remote logical path so path choice cannot change sync identity.

### 5.2 Manifest

An encrypted manifest contains:

```ts
interface VaultManifestV1 {
  schemaVersion: 1;
  vaultId: string;
  revisionId: string;
  parentRevisionIds: string[];
  createdAt: string;
  createdByDeviceId: string;
  operationId: string;
  entries: ManifestEntry[];
  tombstones: Tombstone[];
  conflicts: ConflictRecord[];
}
```

An entry contains logical identity, adapter/version, category, native relative
path template, mode, portable metadata, total size, canonical content digest,
ordered object references, and adapter merge metadata. It MUST NOT use an
absolute path as an identity.

A session checkpoint additionally contains:

```ts
interface SessionCapsuleV1 {
  sessionCapsuleId: string;
  sessionKey: string;
  harnessRevisionId: string;
  harness: {
    namespace: string;
    logicalPath: string;
  };
  workspace: {
    workspaceId: string;
    capsuleRevisionId: string;
    baseCommit?: string;
  };
  drops: Array<{ dropId: string; revisionId: string }>;
  dependencies: DependencyReference[];
  createdAt: string;
  createdByDeviceId: string;
}

interface DependencyReference {
  logicalPath: string;
  source: "git-baseline" | "workspace-overlay" | "drop" | "external";
  contentDigest?: string;
  gitObjectId?: string;
  required: boolean;
}
```

Session capsules are immutable. `resume latest` selects the newest compatible
capsule; resuming a historical session selects its recorded closure rather than
whatever workspace head happens to be current.

The current writer creates all references in a new capsule against the same
atomic vault revision. A client that encounters independently pinned component
revisions MUST either materialize each referenced namespace from its recorded
revision or fail closed; it MUST NOT substitute current heads.

### 5.3 Synchronized namespaces

Every manifest entry belongs to exactly one namespace:

1. `harness/<harness>/<profile>` for native sessions/config/skills;
2. `workspace/<workspaceId>` for Git baseline, overlay, and activity metadata;
3. `drop/<dropId>` for a user-selected arbitrary synchronized root.

Namespace IDs, not local roots, determine collision and authorization. A
device mapping holds the local absolute path, case-sensitivity behavior, and
filesystem capabilities. Cross-namespace hard links are never reproduced.

## 6. Cryptography and key management

This section is the required construction, subject to an independent security
review before production data is accepted.

### 6.1 Key hierarchy

- Each vault begins with a random 256-bit root key at key epoch one. Every
  rotation creates a new independent root and advances the epoch by one.
- Domain-separated scope encryption and deduplication keys are derived from
  the root for that epoch and for global config, global skills, each
  workspace/Drop/harness, and an optional secrets compartment.
- Persistent devices keep a historical vault keyring and receive a sealed-box
  envelope for each new epoch only while they are active vault members.
- Ephemeral bootstrap capabilities receive only the requested workspace keys
  and optional read-only global skill/config keys.
- Authentication signing keys are separate from encryption keys.

This separation allows a sandbox to append a project session without gaining
access to every session or secret in the vault.

### 6.2 Object envelope

- Compute `objectId = BLAKE2b-256(scopeDedupKey, domain || plaintextChunk)`.
- Compress before encryption only when the adapter marks the content safe and
  compression saves a configured minimum.
- Encrypt with an authenticated-encryption algorithm from a maintained,
  reviewed library using a cryptographically random nonce per first upload.
- Bind schema version, vault ID, scope ID, object ID, compression, and plaintext
  length as authenticated additional data.
- Store algorithm/version, nonce, ciphertext, and tag in a versioned binary
  envelope.
- Never reuse a nonce with the same encryption key.

Randomized ciphertext and keyed object IDs prevent public plaintext hashes.
Conditional first-writer object creation permits cross-device deduplication:
once an object exists, later devices reference it instead of replacing it.

Exact library and algorithm selection is a release-blocking ADR. The approved
properties are authenticated encryption, 256-bit keys, safe cross-platform
nonce generation, domain separation, versioned envelopes, and test vectors.
No custom primitive is permitted.

### 6.3 Device enrollment

Interactive enrollment creates signing and key-exchange keypairs locally. The
service receives public keys. The encrypted recovery flow supplies a new
persistent device with the historical vault keyring; active members then
receive separately wrapped keys on future rotations. Device revocation blocks
new API operations but cannot make already decrypted data disappear from that
device.

Recovery material MUST be shown once, never logged, and tested with a recovery
verification step during onboarding.

After revoking a lost device, an owner rotates each affected vault. The client
MUST generate a fresh root rather than rewrap the old root, seal it separately
to the exact active-member public-key set, and publish all envelopes plus the
next epoch in one D1 transaction. The transaction MUST fail if an active member
lacks an exchange key, the membership changes, recipients are missing or
duplicated, or the epoch is no longer current. It also revokes all outstanding
capability grants and sessions for the vault.

The vault Durable Object serializes the D1 rotation with final commit epoch
checks. It persists a monotonic minimum write epoch before dispatching the
transaction; D1 below that floor blocks commits until a valid rotation retry
completes it. An ambiguous D1 result MUST NOT roll the floor back. Capability
insertion checks epoch and active owner inside its own D1 transaction.
Registered device exchange keys are immutable; key replacement requires a new
device identity. See ADR-0019 for ordering and failure recovery.

Namespace heads, immutable manifests, and entries carry their encryption
epoch. The first commit after rotation MUST be a snapshot, not an append delta;
the Worker rejects stale-epoch writes and all protocol 1.0 writes after epoch
one. Active clients fetch and unwrap every missing per-device envelope in
order. Any gap fails closed. Version-two recovery kits contain every retained
historical root plus the current epoch and are required for a replacement
device after rotation. Enrollment submits the kit epoch and D1 validates it
inside membership insertion; a stale kit MUST NOT add membership or become
local authority. An omitted epoch is treated as one for old-client compatibility.

The recovery kit is written exclusively before the remote mutation. An
ambiguous response is reconciled by reading the authoritative epoch and opening
the current device's envelope, then comparing the recovered root to the
candidate root in constant time. If that proof cannot be obtained, the kit is
preserved and local credentials remain at the old epoch. See ADR-0019.

### 6.4 Bootstrap capability

`STATECASE_BOOTSTRAP_TOKEN` is a random 256-bit one-time secret. The service
stores only its SHA-256 digest and an opaque client-encrypted envelope
containing:

- server-verifiable authorization;
- expiry and one-time redemption identifier;
- vault, workspace, harness/category, and method scopes;
- material required to unwrap only the authorized scope keys.

It MUST be safe to revoke, MUST be redacted in all outputs, and SHOULD be
injected through a secret manager. Long-lived `STATECASE_TOKEN` is supported
only for trusted automation. Tokens MUST NOT be placed in prompts or command
arguments visible in process listings; stdin, a protected file, or environment
secret injection is preferred.

## 7. Local state

Statecase stores its own state under `STATECASE_HOME`, defaulting to
`~/.statecase`:

```text
config.json                non-secret profiles and mappings
credentials.json           owner-only bearer session and vault keys (initial release)
state.db                    WAL-enabled local operation journal
cache/objects/              bounded encrypted/plaintext-safe cache by policy
locks/                      instance locks
logs/                       redacted rotating diagnostics
bin/                        optional transparent shims
skills/                     canonical installed skill payload
```

Credential resolution order:

1. explicit protected file/stdin option for one invocation;
2. `STATECASE_BOOTSTRAP_TOKEN` for bootstrap only;
3. scoped environment token for automation;
4. OS keychain/credential store;
5. interactive login.

The local database records operations, observed file fingerprints, object
upload status, applied remote revisions, pending tombstones, path mappings,
daemon leases, and redacted errors. A crash at any instruction boundary MUST
allow replay without duplicate commits or lost queued changes.

## 8. Harness adapter contract

Each adapter implements:

```ts
interface HarnessAdapter {
  id: string;
  version: number;
  discover(ctx: DeviceContext): Promise<Discovery>;
  classify(path: string): Promise<Classification | null>;
  scan(ctx: ScanContext): AsyncIterable<PortableEntry>;
  readStable(entry: PortableEntry): Promise<CanonicalContent>;
  merge(input: MergeInput): Promise<MergeResult>;
  planMaterialization(input: MaterializeInput): Promise<MaterializePlan>;
  validate(plan: MaterializePlan): Promise<ValidationResult>;
}
```

Adapters MUST allowlist portable content. Unknown paths are excluded and
reported, not uploaded automatically.

### 8.1 Codex adapter

Codex state defaults to `CODEX_HOME` or `~/.codex`. Official OpenAI
documentation states that this root includes configuration, authentication,
logs, sessions, skills, and package metadata, and that SQLite state may be
relocated using `CODEX_SQLITE_HOME`. See [Codex environment variables](https://learn.chatgpt.com/docs/config-file/environment-variables).

The adapter MUST resolve these environment overrides per launched process. It
MUST treat active SQLite databases, WAL/SHM files, locks, logs, package caches,
and downloaded binaries as unsafe/non-portable unless a specific consistent
export implementation exists. Session JSONL is read only through complete
records. User skills are installed through `$HOME/.agents/skills`; repository
skills remain Git-owned unless explicitly selected.

### 8.2 Claude adapter

The adapter resolves the configured Claude root, classifies project/session
JSONL, skills, settings, memory, and plans, and filters auth/cache/telemetry by
default. It stores the logical workspace identity separately from Claude's
path-derived native project location. Materialization maps the logical
workspace to the local native layout and validates that a restored session can
be listed/resumed before marking the revision applied.

For Claude SDK/headless usage, a native external session-store adapter MAY be
added. Interactive Claude CLI remains supported through the filesystem adapter
and transparent runtime.

### 8.3 Secrets

Harness auth, OAuth sessions, API keys, and machine-bound tokens are excluded
by default. Enabling the `secrets` category requires an explicit separate scope
key and warning. Ephemeral capabilities MUST NOT receive it in v1.

## 9. Safe file observation

Before reading a mutable file, the adapter records size, mtime, inode/file ID,
and a prefix/suffix sample. It reads through a descriptor, then rechecks the
fingerprint. A mismatch retries with debounce.

For append-only JSONL:

- retain an offset and digest of the accepted prefix;
- read only through the last complete newline;
- validate each new JSON value and adapter schema constraints;
- if the previous prefix changed, classify as rewrite/divergence;
- never publish an unterminated or invalid tail;
- retain the tail locally for the next scan.

For atomic-replace configuration files, wait for stability and ingest the new
complete file. Symlinks are recorded only when the resolved target remains
inside an allowlisted root; otherwise exclude them. Sockets, devices, FIFOs,
and hard-link tricks are excluded.

### 9.1 Workspace capsules

The default workspace mode is `git-overlay`. Each capsule contains:

```ts
interface WorkspaceCapsuleV1 {
  workspaceId: string;
  repository: {
    canonicalRemote: string;
    baseCommit: string;
    branch?: string;
    detached: boolean;
    submoduleCommits: Record<string, string>;
  };
  indexOverlay: WorkspaceEntry[];
  worktreeOverlay: WorkspaceEntry[];
  untracked: WorkspaceEntry[];
  tombstones: WorkspaceTombstone[];
  activity: ActivityReference[];
  ignorePolicyDigest: string;
}
```

The scanner SHOULD use Git plumbing/porcelain with NUL-delimited output and
MUST verify content hashes after enumeration. It records enough index and
worktree state to reproduce staged versus unstaged content where the Git
version supports it. It includes renames as content plus source tombstone so a
receiver does not depend on heuristic rename detection.

Untracked inclusion order:

1. deny unsafe types and roots;
2. apply built-in secret/cache exclusions;
3. apply `.statecaseignore`;
4. apply workspace policy for `.gitignore` (default: respect it);
5. include files explicitly referenced by an allow rule;
6. require confirmation for a file over the configured threshold.

`.env`, private keys, credential files, `.git`, dependency/vendor directories,
build output, sockets, and device files are excluded by default. A secret
scanner flags suspicious included content before first publication. Overrides
must be explicit, local, and auditable.

Hydration requires the exact base commit. If it is already present, no tracked
baseline bytes are transferred. Otherwise Statecase invokes a user-configured
Git fetch/clone workflow or reports `BASELINE_UNAVAILABLE`; it MUST NOT embed
Git credentials in a manifest. The implemented `ask|auto|never` policy is
device-local and per workspace. `ask` and `never` fail before Git network or
workspace mutation; `auto` invokes system Git with interactive prompts disabled
against the checkout's existing `origin`, attempts the exact object before a
bounded fallback fetch, and emits only redacted diagnostics. All workspaces are
preflighted first. Acquired checkouts and indexes roll back in reverse order if
any later acquisition or materialization fails. Existing divergent local
changes produce a previewable conflict and are never overwritten.

For subsequent sync, a Git-dirty destination MAY advance only after its full
current capsule is verified against the authenticated last-applied namespace
revision (ADR-0020). Local digest claims alone MUST NOT authorize replacement.
The implementation MUST preserve independent staged/worktree state, revert
obsolete overlay entries correctly, respect Git's index lock, recheck source
stability, and materialize workspace/index/session changes transactionally.
Missing history, new local edits, ignored-file collisions, or failed validation
MUST leave applied markers unchanged. Preview MUST NOT mutate files or markers.
Crash recovery and concurrent-writer qualification remain release requirements,
not implied by the initial successful return-sync regression.

Managed branch movement and rollback MUST compare the expected previous Git
object ID; changing HEAD identity MUST NOT rewrite an independently advanced
source branch. File rollback MUST preserve independently changed destinations
and retain available original backups when exact rollback is unsafe or fails.
The reserved `.statecase-transaction-<uuid>.staged|backup` artifacts MUST remain
local and excluded from ordinary sync, including case variants of every path
component so a case-sensitive sender cannot bypass a case-insensitive receiver.
Retained ad-hoc backups MUST NOT be
represented as an authenticated or crash-qualified emergency snapshot.

Baseline blobs that conform to the Git LFS pointer format MUST NOT be treated as
the referenced content. Capture and hydration report
`GIT_LFS_CONTENT_UNAVAILABLE` with logical paths while the worktree still holds
a pointer or omits the file. A capsule-provided worktree replacement or deletion
satisfies this check. `ask` and `never` MUST perform no LFS network or working-tree
mutation. Under explicit `auto` policy, Statecase MUST first attempt a
device-local `git lfs checkout`, then use bounded non-interactive system Git LFS
to fetch the exact baseline from the existing `origin` and retry checkout when
the object is absent. Repository fetch include/exclude settings MUST NOT make a
required baseline appear complete. Materialized bytes MUST match the pointer's
declared size and SHA-256. Failure diagnostics MUST redact raw Git LFS output,
and partial materialization MUST be restored when acquisition or the enclosing
workspace transaction fails. Statecase MUST NOT serialize remotes or Git/LFS
credentials.

Modes:

- `metadata-only`: session linkage but no source overlay;
- `git-overlay`: recommended baseline plus non-reproducible changes;
- `mirror`: explicit non-Git/full-tree synchronization with Drop-like rules.

`workspace capsule <workspaceId>` performs a local preview of a configured
`git-overlay` workspace. It forces non-fetching `ask` acquisition policy,
performs no cloud request or configuration mutation, and exposes only the
baseline commit, head ref, and aggregate record/blob counts and byte size. It
MUST NOT emit captured file bytes. `metadata-only` mappings have no Git capsule
and are rejected. This local Workspace Capsule preview is distinct from the
immutable remote Session Capsules inspected by `workspace dependencies`.

### 9.2 Harness activity and read/write completeness

Statecase maintains a workspace-relative activity index:

```ts
interface ActivityReference {
  path: string;
  access: "read" | "write" | "create" | "delete" | "rename";
  source: "native-event" | "session-transcript" | "filesystem-diff" | "os-trace";
  observedAt: string;
  contentDigest?: string;
}
```

Collection precedence is harness-native tool events, parsed transcript events,
and deterministic filesystem/Git reconciliation. Optional OS tracing may
enrich the index on supported platforms but is not required for correctness.
Linux `fanotify`/eBPF or process tracing and macOS facilities have different
privilege, completeness, and privacy properties, so v1 MUST NOT depend on them.

At harness launch the runtime records the base commit, index tree/digest, Git
status, and selected Drop heads. During execution, it builds a touched-path set
from native events, transcript tool events, and filesystem write notifications.
At checkpoint/final flush it always reconciles against Git status and index
state, because watchers can drop events. Only changed candidates and permitted
untracked content require hashing; unchanged tracked reads use the Git object
ID from the pinned baseline.

Continuity rules:

- a read-only tracked file is satisfied by the pinned Git baseline;
- a read or write whose resulting content differs from the baseline is in the
  workspace overlay;
- an untracked referenced file is included only if policy permits;
- a referenced path outside the workspace is reported as an external
  dependency and never silently copied;
- users can satisfy external dependencies by mapping a Drop;
- hydrate reports unresolved references before launching the resumed session.

Hydration modes are `warn` (default interactive), `strict` (abort on a required
unresolved dependency), and `best-effort` (automation explicitly accepts an
incomplete closure). The selected mode is recorded in audit metadata. A file
read from a Drop is pinned to the Drop revision observed by the Session Capsule,
not silently substituted with its latest version.

This avoids hashing/uploading every unchanged file on every sync while still
detecting incomplete resumptions.

### 9.3 Arbitrary Drops

A Drop is a logical tree selected by the user:

```bash
statecase drop add ~/agent-material --name agent-material
statecase drop map agent-material /srv/agent-material
statecase drop status agent-material
statecase drop remove agent-material
```

Each Drop has an ID, display name, device-local root mapping, category/scope
key, ignore rules, file-size policy, case-sensitivity policy, and sync mode.
The remote manifest contains only normalized slash-separated relative paths.

Drop modes:

- `two-way`: normal synchronization with conflicts;
- `publish`: this device writes; consumers read;
- `consume`: read-only on this device;
- `append`: only new immutable paths may be created.

Conflicting text files MAY use a safe three-way merge when a common base and
validated encoding exist. All other conflicts preserve both variants with
device/revision metadata. Case collisions, Unicode normalization collisions,
reserved Windows names, and path-length incompatibilities block
materialization and appear in `statecase conflicts`.

`drop status [dropId]` is a bounded metadata check: it reports whether the
device-local root is available and compares the locally applied namespace
revision with the visible remote head. `applied` therefore means revision-head
alignment, not that local content was scanned for pending changes. A scoped
client reports an ungranted namespace as `unauthorized`, never as an absent
remote Drop. `drop remove` removes only the device-local mapping and applied
marker; it does not delete local files or the encrypted remote namespace.

## 10. Sync protocol

### 10.1 Push

1. Reconcile adapter roots against the local journal.
2. Canonicalize portable entries and compute keyed object IDs.
3. Call `POST /v1/sync/plan` with vault, base revision, operation ID, entry
   summaries, and object IDs.
4. Upload only missing encrypted objects using conditional PUTs.
5. Upload the encrypted manifest candidate.
6. Call `POST /v1/vaults/:vaultId/commits` with base revision and manifest
   reference.
7. The Durable Object accepts, reports idempotent prior success, or returns a
   structured conflict/rebase requirement.
8. Persist the acknowledged revision locally before pruning operation state.

### 10.2 Pull

1. Read the authenticated vault head.
2. If unchanged, finish without scanning remote objects.
3. Fetch and decrypt required manifests.
4. Compare logical entries to the last applied revision and local journal.
5. Download missing objects and verify envelope authentication, IDs, lengths,
   and canonical content digests.
6. Resolve portable sessions through the device-local native binding, or the
   adapter's canonical fallback on a fresh device.
7. Build a materialization plan in a staging directory.
8. Validate adapter invariants, binding uniqueness, and available disk space.
9. Atomically replace safe files or append verified records.
10. Record the applied revision and native session bindings only after
    successful materialization.

### 10.3 Commit concurrency

Every commit includes `baseRevisionId`. If it differs from the current head:

- disjoint logical entries merge automatically;
- append-only sessions with verified common prefixes merge by record identity;
- identical changes deduplicate;
- config/settings use a three-way merge only for formats with a safe parser;
- delete versus modify becomes a conflict;
- the same session with different rewrites becomes preserved forks;
- unknown/binary conflicts preserve both versions and require resolution.

For a recognized portable session, a full-key client performs the append merge
only when the last locally applied base is a byte-identical, complete JSONL
prefix of both local and remote branches. Canonical JSON plus occurrence ordinal
identifies records; a deterministic topological order preserves both branch
orders and deduplicates only shared occurrences. Invalid UTF-8, malformed or
partial records, prefix rewrites, and order cycles fail closed. The Worker sees
only encrypted objects and authenticated manifest metadata. Scoped capability
clients never use this same-path merge path. A merged publisher deliberately
keeps its prior applied marker until a subsequent pull proves that the remote
record stream retains every local occurrence in order. The client validates and
copies the common base as a stream, compares both prefixes byte for byte, and
holds only the two concurrent suffixes and their merge graph. Each suffix is
bounded to 256 MiB and 100,000 records; total session history is bounded by the
20-GiB session limit. The merged output and the accepting supersequence check
are file-backed and record-streamed.

No last-writer-wins rule is allowed for user content. Same-key R2 behavior is
irrelevant to correctness because objects are immutable and the Durable Object
orders head changes.

### 10.4 Leases

A client MAY request a short advisory session lease. Leases improve UX but do
not replace optimistic concurrency, because a client may be offline. Lease
expiry, clock skew, and client death MUST not prevent future work.

### 10.5 Tombstones

A deletion records logical entry ID, deleted revision, device, and prior
content digest. Tombstones participate in merge and retention. They do not
delete R2 objects immediately. Restoring a tombstoned entry creates a new
revision rather than rewriting history.

## 11. HTTP API

All mutation requests require `Authorization: Bearer`, `Idempotency-Key`,
device signature where enabled, protocol version, and bounded request size.
Errors use one envelope:

```json
{
  "error": {
    "code": "REVISION_CONFLICT",
    "message": "The vault head advanced",
    "retryable": true,
    "requestId": "req_...",
    "details": { "currentRevisionId": "rev_..." }
  }
}
```

Initial endpoints:

```text
POST   /v1/auth/device/start
POST   /v1/auth/device/complete
POST   /v1/auth/token/refresh
POST   /api/bootstrap/redeem
GET    /v1/devices
DELETE /v1/devices/:deviceId
GET    /v1/vaults/:vaultId/key-recipients
GET    /v1/vaults/:vaultId/key-envelope
GET    /v1/vaults/:vaultId/key-envelopes?afterEpoch=<epoch>
POST   /v1/vaults/:vaultId/key-rotations
POST   /v1/tokens
GET    /v1/tokens
DELETE /v1/tokens/:tokenId
POST   /v1/sync/plan
PUT    /v1/vaults/:vaultId/objects/:objectId
GET    /v1/vaults/:vaultId/objects/:objectId
PUT    /v1/vaults/:vaultId/manifests/:revisionId
GET    /v1/vaults/:vaultId/manifests/:revisionId
GET    /v1/vaults/:vaultId/head
POST   /v1/vaults/:vaultId/commits
GET    /v1/vaults/:vaultId/namespaces
PUT    /v1/vaults/:vaultId/namespaces/:namespace/objects/:objectId
GET    /v1/vaults/:vaultId/namespaces/:namespace/objects/:objectId
GET    /v1/vaults/:vaultId/namespaces/:namespace/revisions/:revisionId
GET    /v1/vaults/:vaultId/scoped-revisions/:revisionId
POST   /v1/vaults/:vaultId/namespace-commits
POST   /v1/vaults/:vaultId/sessions/:sessionId/lease
DELETE /v1/vaults/:vaultId/sessions/:sessionId/lease
GET    /v1/vaults/:vaultId/snapshots
POST   /v1/vaults/:vaultId/snapshots
DELETE /v1/vaults/:vaultId/snapshots/:snapshotId
POST   /v1/vaults/:vaultId/garbage-collection
GET    /v1/vaults/:vaultId/workspaces
GET    /v1/vaults/:vaultId/drops
```

`sync/plan` and commit responses MUST be deterministic for the same authorized
input and operation ID. Server timestamps are informational and MUST not be
used to order client content.

Status conventions: `200/201/204` success, `400` invalid protocol input, `401`
missing/expired identity, `403` valid identity outside scope, `404` inaccessible
or absent resource, `409` revision/idempotency conflict, `412` failed object
condition, `413` size limit, `422` semantically invalid manifest metadata,
`429` rate limit, and `5xx` retryable infrastructure failure where applicable.

## 12. CLI contract

```text
statecase login [--device-name] [--device-code] [--non-interactive]
statecase logout
statecase vault create|list|select
statecase vault join <vaultId> --recovery-file <path>
statecase vault key rotate --recovery-file <new-path> --yes
statecase setup [--harness ...] [--transparent] [--dry-run]
statecase bootstrap [--token-file ...] [--non-interactive]
statecase workspace attach [--id ...] [--path ...] [--auto] [--mode git-overlay|metadata-only] [--git-fetch ask|auto|never]
statecase workspace list|move|detach
statecase workspace capsule <workspaceId>
statecase workspace dependencies [--workspace ...] [--revision ...]
statecase workspace hydrate --session ... [--mode strict|warn|best-effort] [--dry-run]
statecase drop add|map|list|remove|status
statecase pull [--category ...] [--revision ...] [--dry-run]
statecase push [--category ...] [--dry-run]
statecase sync [--pull-only|--push-only] [--json]
statecase run <harness> -- <args...>
statecase status [--json]
statecase doctor [--json]
statecase conflicts list|show|resolve
statecase snapshot create|list|protect|delete
statecase restore --revision ... --mapping ... --target ... [--dry-run] [--yes]
statecase restore --revision ... --mapping ... --in-place [--dry-run|--yes]
statecase emergency rollback <snapshot-path> --yes
statecase token create --namespace ... --actions read[,append] --ttl ... --output ...
statecase token list|revoke
statecase device list|approve|revoke
statecase daemon install|start|stop|status|uninstall
statecase skills install|verify|uninstall
statecase which|bypass <harness>
```

Exit codes: `0` success, `2` usage/configuration, `3` authentication, `4`
authorization, `5` conflict requiring action, `6` integrity failure, `7`
temporary network/service failure, `8` partial success/queued work, and `10`
internal invariant failure. Child harness exit codes pass through `run`; sync
warnings are emitted separately and retained in status.

## 13. Skill contract

The canonical skill is installed in each harness-native discovery path.
For Codex, user scope is `$HOME/.agents/skills/statecase`; repository-specific
skills under `.agents/skills` remain source-controlled. Installation MAY use a
symlink because Codex supports symlinked skill directories.

The skill MUST:

- trigger on connect, attach, hydrate, recover, publish, snapshot, status, and
  conflict intents;
- first run `statecase status --json`;
- bootstrap non-interactively only when a supported secret source is present;
- use `--json` and inspect exit codes instead of scraping decorated text;
- never echo, inspect, request in chat, or persist secret values;
- explain when interactive enrollment or recovery is required;
- preview restores and require explicit user authorization for overwrites;
- avoid making model participation necessary for background synchronization.

Skill tests MUST cover both explicit invocation and implicit trigger/negative
trigger prompts.

## 14. Backup, snapshot, retention, and restore

Every successful commit is a revision. Protocol 1.1 namespace commits include
opaque reachability metadata: the manifest object, every required entry and
conflict object, append parent mode, and the vault revision IDs pinned by
Session Capsules. This metadata contains identifiers only; the Worker never
decrypts manifests, paths, prompts, sessions, or dependency names.

The coordinator selects the newest server-ordered revision in each of 24 UTC
hourly, 30 UTC daily, and 12 UTC monthly buckets. A manual protected snapshot
is an immutable named reference with audit metadata. The current scoped head,
checkpoints, protected snapshots, recursively resolved Session Capsule pins,
and append-delta parents form the reachability roots. Namespace objects outside
that graph become eligible only after the configured 30-day production grace
period. Legacy objects, objects uploaded before tracking began, and namespaces
with missing historical reachability metadata fail conservative and are not
automatically deleted.

The Worker inventories only the target vault's R2 prefix. A per-vault Durable
Object lease excludes commits while an executable plan is deleting exact R2
keys; racing commits receive retryable `GC_BUSY`. Snapshot creation may proceed
because it can only pin the already-rooted current head. Finalization
recalculates reachability from the leased roots, persists checkpoints, and
prunes obsolete coordinator metadata. After lease expiry, writes remain
blocked: the next scheduled or owner-invoked collector takes over, finalizes
the same retained roots, recalculates deletion against R2, and completes a new
lease before admitting another commit. A commit cannot clear an expired lease,
because the prior Worker might still be deleting. Inventory and graph traversal
are each bounded to 100,000 records and fail without deletion when exceeded.

Cloudflare invokes this path daily at 03:17 UTC. The owner-only endpoint
defaults to dry-run and returns aggregate encrypted-object counts and bytes,
not raw object identifiers. `statecase retention collect --yes` is the explicit
operator path; direct R2 prefix deletion is never supported. See
[ADR-0017](adr/0017-retention-and-reachability-gc.md).

Restore modes:

- in-place stopped-harness restore;
- staging-directory restore;
- category/workspace/session selective restore;
- revision comparison and preview;
- forked restore that creates a new local/remote revision.

In-place restore MUST refuse active SQLite/WAL targets and MUST preserve a
local emergency snapshot of files it will replace. Restore completion requires
adapter validation; a downloaded but unmaterialized revision is not success.

The current implementation enables in-place mode only for full-key devices and
configured two-way Drop, Codex, Claude, or `git-overlay` workspace mappings.
Actual execution MUST:

1. require explicit `--in-place --yes`; dry-run MUST remain non-mutating;
2. acquire the daemon profile lock and, for a harness, an exclusive restore
   barrier plus a redacted OS process check;
3. create a protected snapshot of the current remote head;
4. create and fsync an owner-only emergency snapshot for the exact transaction
   path set before changing any target; workspace snapshots also preserve HEAD,
   refs that can move, and the raw index while pinning recovery commits locally;
5. transactionally materialize and adapter-validate the authenticated target;
6. commit a new forward namespace/global revision preserving historical
   Session Capsule pins; and
7. roll local bytes back from the emergency snapshot if validation or the
   optimistic commit fails.

The configured target path is inferred from the mapping and an explicit
`--target`, if supplied, MUST match it. Staging mode MUST refuse that configured
path so an operator cannot accidentally bypass in-place safeguards. Emergency
rollback is local/offline, requires `--yes`, and applies the same daemon and
harness exclusion. Workspace replacement MUST preflight capsule integrity,
baseline policy, special-file and initialized-submodule boundaries before its
recovery callback. It then replaces the exact baseline/ref, index, tracked and
untracked overlay as one recoverable operation. Any HEAD, ref, index, or
worktree race while recording recovery state aborts before mutation.

## 15. Observability and privacy

Structured logs contain request/operation IDs, component, duration, byte and
object counts, revision IDs, retry class, and redacted errors. They MUST NOT
contain authorization values, encryption material, plaintext paths unless
local debug is explicitly enabled, Git credentials, prompts, or session text.

Metrics include sync latency, no-op latency, bytes deduplicated/transferred,
pending journal age, conflict rate, restore success, bootstrap success, and API
error class. Cloud metadata retention must be documented and minimized.

`statecase doctor --bundle` creates a reviewed redacted archive and previews
its file list before writing it.

## 16. Performance and resource targets

- Warm no-op preflight p95 below 2 seconds.
- Local append journal acknowledgement below 100 ms p95.
- Constant-memory streaming for object payloads.
- Default chunks 4 MiB; never exceed Worker request limits.
- One changed JSONL tail does not re-upload its full multi-gigabyte file.
- A no-change Git workspace uses status/index metadata and does not hash every
  tracked file.
- Unchanged tracked source is obtained from the pinned Git baseline, not R2.
- Bounded local cache with LRU and pinning for pending operations.
- Initial sync supports at least 20 GiB and 100,000 logical entries through
  pagination and streaming.
- Rate limiting is per account/device with retry headers and jittered clients.

Recognized harness JSONL is staged record by record in an owner-only temporary
directory. A single record is bounded to 64 MiB; the overall staged session is
bounded to 20 GiB. Keyed content digests use the incremental libsodium generic
hash API and must remain byte-compatible with v1 object identities. JSONL
objects use deterministic complete-record boundaries with a 4 MiB target and
hard 4 MiB ceiling; oversized records are split without changing reconstructed
bytes. Upload encrypts and sends one object at a time and skips object IDs
already named by the authenticated remote namespace manifest. Pull decrypts
one object at a time, verifies total size and the incremental content digest,
localizes portable paths record by record, then atomically installs the
verified file-backed staging artifact. New empty vaults start directly on
protocol 1.1; existing protocol 1.0 heads retain the fail-closed migration path.

The concurrent merge path uses the same staging discipline. It downloads and
authenticates base and remote versions one object at a time, validates the
potentially multi-gigabyte base without retaining it, loads only the bounded
branch suffixes, and emits base plus deterministic merged suffix to a new 0600
staging file. A subsequent pull validates the local record stream as an ordered
subsequence of the merged remote stream with two-record memory. Literal 2-GiB
acceptance remains required before the scaled claim is released.

Before each plaintext staging allocation, the client queries the destination
filesystem's available blocks and requires the predicted copy count plus a
64-MiB safety reserve. Push uses a conservative two-copy estimate; download,
localization, merged-output creation, and the atomic materialization copy
recheck capacity as earlier staging files accumulate. This is a preflight
rather than a reservation, so `ENOSPC` must still trigger cleanup and leave
native destinations unchanged. For temporary filesystems that discard empty
directories, the client recreates the configured temporary root, allocates a
private child, and runs `statfs` against that materialized child. A failed
preflight removes the child before returning.

## 17. Failure behavior

| Failure | Required behavior |
| --- | --- |
| Network loss during upload | retain journal; retry missing object only |
| Worker timeout after commit | repeat operation ID; receive same result |
| Device crash during materialization | recover staging transaction; never mark applied early |
| R2 object corrupt/missing | integrity error, quarantine, no materialization |
| D1 unavailable | content operations fail closed; local work continues |
| Durable Object unavailable | queue local work; do not invent a head |
| Token expires | refresh or return auth code; never discard work |
| Device revoked mid-session | local work remains; remote writes denied |
| Rotation response lost | verify own new envelope; otherwise preserve recovery kit and report unknown outcome |
| Active-device key history has a gap | integrity exit; do not read or write with a guessed/current-only key |
| Recovery kit is older than the vault | reject join locally; require the current encrypted keyring kit |
| Disk full | stop before replace; preserve native files and journal |
| Clock wrong | rely on server expiry and revision graph, not client ordering |
| Two devices delete/modify | preserve modification and conflict record |
| Harness upgrades format | adapter refuses unknown version, keeps raw local state |

## 18. Compatibility and schema evolution

Protocol requests carry a major/minor version and client capabilities.
Manifests and object envelopes are independently versioned. Readers MUST ignore
unknown optional fields and reject unknown required features. Writers never
rewrite historical manifests during a schema migration; they create a new
revision in the new format.

Statecase has no legacy product configuration or backup-repository migration in
the initial release. It MUST NOT inspect or mutate AgentStash or ClawStash configuration.
Any future importer requires a separate ADR and remains a one-way, previewed,
copy-only operation.

## 19. Delivery sequence

1. Freeze protocol/domain types and golden fixtures.
2. Establish standalone workspace/package boundaries and architecture tests.
3. Implement crypto envelopes and test vectors.
4. Implement local journal and deterministic manifest builder.
5. Implement in-memory reference server and contract suite.
6. Implement Hono Worker, D1 migrations, R2 store, and Vault Durable Object.
7. Implement Codex adapter, then Claude adapter.
8. Implement push/pull and recovery transactions.
9. Implement daemon and `statecase run`.
10. Implement auth, enrollment, bootstrap capabilities, and revocation.
11. Implement canonical skill and installers.
12. Run failure injection, security, isolation, and UAT gates.
13. Private beta behind an explicit opt-in flag.

Each step begins with failing tests identified in the accompanying test plan.

## 20. Release blockers

- independent review of the accepted cryptographic integration;
- no recovery drill on clean machines;
- any silent last-writer-wins content path;
- any plaintext content observed in Worker/R2/D1/log captures;
- inability to bypass or uninstall shims safely;
- unbounded first-sync memory or request sizes;
- lack of constant-memory, incremental transfer and append merge for
  multi-gigabyte sessions;
- critical test or UAT scenario not automated/documented.
