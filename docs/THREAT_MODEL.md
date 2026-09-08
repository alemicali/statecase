# Statecase threat model

Status: baseline threat model; update with every trust-boundary change
Last updated: 2026-09-05

## Security objectives

Statecase must preserve confidentiality, integrity, availability, isolation,
recoverability, and auditable intent for harness state, workspace capsules,
Drops, encryption material, device identities, and control-plane operations.

The most serious prohibited outcomes are:

- plaintext agent content or secrets reaching cloud storage/logs;
- one account, vault, workspace, or bootstrap capability accessing another;
- silent overwrite, deletion, truncation, rollback, or incomplete resume;
- an attacker converting read/append access into overwrite/delete/key access;
- restore/materialization escaping an approved local root;
- loss of all recovery paths through sync propagation or garbage collection.

## Assets

- vault root and scope keys;
- device private keys, recovery material, access/refresh/bootstrap tokens;
- session transcripts, memory, skills, configuration, and optional secrets;
- Git workspace overlays, untracked files, activity/dependency metadata;
- arbitrary Drop content;
- manifest graph, tombstones, protected snapshots, and conflict variants;
- account/device/workspace metadata and audit events;
- native harness state and unrelated local backup repositories.

## Actors

- authorized human owner;
- authorized persistent device;
- restricted ephemeral/automation client;
- untrusted repository/workspace content executed by a harness;
- compromised or revoked device;
- external network attacker;
- malicious service tenant;
- honest-but-curious or compromised cloud component/operator;
- malicious dependency, package, CI job, or release artifact.

## Trust boundaries

1. Human/secret manager to local CLI.
2. Harness/native files to adapter and materializer.
3. Untrusted project content to the Statecase process environment.
4. Local client to HTTPS Worker.
5. Worker to Durable Object, D1, and R2 bindings.
6. Persistent device to ephemeral capability.
7. Git provider/checkout to workspace capsule.
8. CI/release system to published package and cloud deployment.

Cloudflare is trusted for service availability and access-control execution but
not with plaintext content. TLS is defense in depth; payload confidentiality
comes from client-side encryption.

## Assumptions and non-protections

- A fully compromised authorized device can read data already decrypted on it.
- Revocation prevents future service access but cannot erase copied plaintext or
  keys from a previously authorized device.
- Post-revocation rotation protects data first encrypted under the new epoch;
  it does not retroactively hide historical ciphertext that the device already
  downloaded.
- A malicious harness running with user filesystem permissions can access what
  that user exposes to it; Statecase minimizes additional credentials/scopes.
- Availability cannot be guaranteed during provider/network outage; local-first
  operation and export reduce impact.
- Traffic timing, encrypted object size, account/device identifiers, and sync
  frequency may remain visible metadata.
- Git provider security and repository access control remain external concerns.

## Threats and controls

### Credential theft and confused deputy

Threats: token in prompt/log/process list; repository script reads environment;
replayed device code; stolen bootstrap capability; one client signs for another.

Controls:

- keychain or protected-file credentials for persistent clients;
- single-use, short-lived, workspace/category/method-scoped bootstrap tokens;
- refresh rotation, server-side expiry/revocation, audience binding;
- separate device signing and encryption keys;
- device-local X25519 exchange keys and per-epoch sealed-box vault-key
  envelopes; rotation uses a fresh root and the exact active-member set;
- D1 transaction triggers enforce next-epoch/exact-recipient invariants while
  the coordinator rechecks commit epochs, persists a write-epoch floor before
  rotation, and D1 revokes outstanding capabilities; grant insertion checks
  epoch/active-owner identity transactionally, and registered exchange keys
  are immutable so recipient discovery cannot race a key replacement;
- sequential key-history ingestion, multi-epoch encrypted recovery kits, and
  cryptographic reconciliation of ambiguous rotation responses;
- CLI redaction and no secret values in arguments or JSON output;
- append-only ephemeral default and no ephemeral secrets scope;
- optional secret-file descriptor/secret mount consumed then removed;
- AU and SEC tests plus audit events for issuance/redemption/revocation.

### Cross-tenant and cross-scope access

Threats: guessed IDs, missing D1 tenant predicate, R2 key manipulation, object
existence oracle, workspace capability accessing global/secrets data.

Controls:

- server-derived account/vault binding, never client-only tenancy;
- opaque identifiers and uniform inaccessible/not-found behavior;
- scope keys separated by workspace/category;
- R2 access only through authenticated binding code in v1;
- centralized authorization middleware plus endpoint contract tests;
- property tests over every role/method/resource combination.

### Cloud plaintext disclosure

Threats: unencrypted manifest field, request/error logging, analytics body,
debug dump, D1 content column, R2 plaintext object.

Controls:

- encryption before HTTP and encrypted manifests;
- allowlisted small plaintext metadata schema;
- body logging prohibited; structured redacted logging;
- plaintext canaries inspected across Worker, D1, R2, logs, and CI artifacts;
- server packages do not depend on decrypt capability or receive vault keys.

### Object/manifest tampering and rollback

Threats: bit flips, object substitution, malicious R2 operator, old manifest
replay, truncated upload, forged parent graph.

Controls:

- AEAD with authenticated context; keyed content IDs and canonical digests;
- immutable conditional object writes;
- Durable Object ordered head and idempotent commit records;
- parent/capability validation and client remembered/applied head;
- length, schema, decompression, and graph bounds before materialization;
- corruption quarantine and no partial apply.

### Concurrency, ransomware, and destructive propagation

Threats: two writers, compromised device mass delete/encrypt, stale offline
client, last-writer-wins, GC racing a restore/snapshot.

Controls:

- optimistic base revision and preserved forks/conflicts;
- tombstones instead of immediate deletion;
- protected snapshots, deterministic UTC retention, grace period, and opaque
  reachability GC rooted through Session Capsules and append parents;
- per-vault GC lease excludes commits during exact-key R2 deletion; an expired
  lease remains a write barrier until a collector takeover finalizes the prior
  roots and completes a newly calculated deletion pass;
- pre-tracking, legacy, missing-metadata, and oversized graphs fail conservative
  without deleting encrypted objects;
- rate/anomaly limits on bulk mutation and optional re-authorization threshold;
- append-only sandbox permission;
- dry-run and emergency local restore snapshot;
- immutable audit metadata and recovery drills.

### Filesystem and archive attacks

Threats: traversal, symlink race, hard-link trick, FIFO/device blocking, case or
Unicode collision, destination path swap, disk exhaustion, decompression bomb.

Controls:

- allowlisted roots, descriptor-based stable reads, repeated fingerprints;
- no-follow/open checks and target containment verification;
- exclude unsafe file types and cross-root links;
- normalized relative logical paths and target capability preflight;
- staging transaction and byte/file/depth/compression limits;
- available-block preflight before each plaintext temporary-copy allocation,
  with reserved headroom and fail-clean `ENOSPC` handling;
- atomic apply where supported and rollback otherwise;
- case/normalization/reserved-name conflicts block apply.

### Destructive Git workspace recovery

Threats: partial baseline checkout; branch or detached-HEAD corruption; index
loss; deletion of unsynchronized work; initialized-submodule traversal; a Git
or editor race producing an internally inconsistent recovery point.

Controls:

- explicit `--in-place --yes`, full-key authorization, and daemon exclusion;
- authenticated capsule/blob validation and device-local fetch policy before
  worktree mutation;
- exact affected-path planning across current changes, both baselines, and the
  target overlay;
- persistent backup of worktree bytes, HEAD, affected refs, and raw index;
- private recovery refs keep rollback commits reachable from local Git GC;
- final HEAD/ref/index/file stability recheck before replacement;
- initialized submodules, directory collisions, and special files fail closed;
- validation and optimistic-commit failures restore local Git state before the
  error is returned, while the shared head only advances through a new revision.

### Ordinary managed workspace advancement

Threats: treating already-synchronized Git dirt as arbitrary overwrite consent;
forged local applied digests; missing historical authority; racing a Git writer
or editor; erasing ignored content; partial return-sync corrupting index/HEAD.

Controls under qualification (ADR-0020, WS-034):

- authenticate the exact previous namespace and verify the full current capsule;
- retain conflicts for new edits, absent history, and failed authentication;
- stage the index separately, hold the native index lock, and preserve foreign locks;
- reject unknown destination content and require per-target pre-commit guards;
- rollback file/index failure and restore changed HEAD/ref metadata;
- keep applied markers unchanged on preview or failure.

Further local fault tests now cover expected-value branch update/rollback,
independent source/target branch advances, independent HEAD switches, and
foreign HEAD/ref locks. File rollback detects tested post-install writes,
deletions, and type changes, retains the original backup when restoration would
clobber local work, and excludes transaction artifacts from sync.
Workspace capsule path validation also explicitly refuses `.git` components
case-insensitively and reserved transaction artifacts, including upper/mixed-case
artifact names and parent components; trusted encryption does
not grant a remote writer permission to replace device-local Git configuration
or recovery material. Valid-blob, malicious-destination regressions cover this
boundary before any workspace mutation.

These controls do not yet prove crash-safe persistent recovery, atomic HEAD
exclusion, or protection against races inside the check-to-mutation boundaries.
Those remain release gates; no unconditional concurrent-writer safety claim is made.

### Workspace dependency incompleteness

Threats: transcript restores without modified code; missed watcher event;
unavailable force-pushed commit; ignored/untracked/external input omitted;
latest Drop incorrectly replaces historical input.

Controls:

- Session Capsule binds session, Git baseline, workspace overlay, and Drop heads;
- final Git/index reconciliation is authoritative for writes;
- read index classifies baseline/overlay/Drop/external dependencies;
- historical Drop revision pinning;
- strict/warn/best-effort hydration modes with unresolved report;
- external reads are never silently uploaded;
- Git baseline digest and final reconstructed content verification.

### Native format and live-state corruption

Threats: partial JSONL line, invalid UTF-8, rewritten accepted history,
duplicate/shared records, incompatible concurrent event order, maliciously
oversized manifest entries, active SQLite/WAL copy, harness upgrade, restore
while process writes, machine-specific configuration transported elsewhere,
or a stale/corrupt native-session binding overwriting another local file.

Controls:

- adapter allowlists and versioned fixtures;
- byte-identical accepted-prefix verification and complete-record JSONL parsing;
- deterministic canonical-occurrence merge only on full-key clients;
- streamed byte-exact common-prefix verification with bounded concurrent
  suffixes and record size before append-merge allocation;
- record-supersequence verification before replacing a locally changed session;
- strict portable workspace URI component validation before localization;
- local-only namespace/logical-session bindings with relative-path containment,
  adapter classification, basename validation, and pre-apply collision checks;
- binding and applied-state persistence only after successful non-dry-run
  materialization/publication; deletion removes the binding;
- bounded merge inputs and pre-download declared-size rejection;
- scoped append clients cannot invoke trusted same-path merge semantics;
- exclude live DB/WAL/locks unless a consistent export exists;
- portable-field filtering;
- stopped-harness requirement for dangerous in-place restore;
- fail closed and retain unknown local state.

### Supply-chain and update compromise

Threats: malicious npm/action dependency, lockfile drift, compromised release
token, shim update replacing harness execution, unsigned artifact.

Controls:

- minimal dependencies, lockfile, `npm ci`, audit/dependency review, CodeQL;
- CODEOWNERS and critical-change review;
- protected release environment/OIDC, checksums and provenance where available;
- published package dry-run/content review;
- shim real-binary verification, recursion guard, bypass/uninstall;
- staged updates and rollback.

## Abuse limits

The API enforces bounded object size, manifest depth/count, pagination, request
rate, token creation, concurrent uploads, leases, and retention operations.
Decompression occurs only after authenticated envelope checks and within output
limits. Account suspension must preserve a documented export/recovery path where
contractually required.

## Security verification gates

Before private beta:

- select crypto library/AEAD through ADR and publish cross-platform vectors;
- complete authorization matrix and tenant-isolation tests;
- demonstrate plaintext canary absence in cloud/logs;
- complete traversal/symlink/decompression fuzzing;
- complete device/bootstrap/revocation UAT;
- complete concurrent deletion, retention, GC, and restore drill;
- review package/action dependencies and release provenance;
- document incident response, metadata retention, and recovery limitations.

Before public launch, obtain an independent review of crypto integration,
authorization, materialization, deletion/GC, and bootstrap threat surfaces.

## Residual-risk register

| Risk | Current treatment |
| --- | --- |
| Compromised authorized endpoint | disclosed limitation; least scope/revocation |
| Revoked device retains historical plaintext/key material | fresh-root epoch rotation protects subsequent writes; historical disclosure is irreversible and explicit |
| Lost response after key rotation | decrypt and constant-time match the device envelope; preserve the recovery kit when outcome cannot be proven |
| Cloud metadata leakage | opaque revision/object relationships only; identifiers and lifecycle documented in ADR-0017 |
| Unavailable Git baseline | explicit ask/auto/never policy; bounded system-Git fetch; redacted failure; atomic rollback |
| Git LFS pointer mistaken for content | baseline pointer scan; explicit auto policy; device-local cache/origin/credentials; size and SHA-256 verification; redacted failure and rollback |
| Uncatchable sandbox kill | periodic push; bounded but non-zero loss window |
| Harness format changes | fixtures, fail closed, compatibility window pending |
| User explicitly includes secrets in Drop | warning/scanner/separate scope; user choice |
| Cryptographic construction defect | release-blocking ADR and independent review |
