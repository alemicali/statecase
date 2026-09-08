# Statecase threat model

## Incremental admission corrections (ADR-0037)

Unchanged namespace heads do not authorize rewriting their locally growing
context when an unrelated Drop advances. Validate configured permissions and
missing heads before narrowing downloads/materialization; retain unchanged
applied markers and bindings. This is not exclusion for an actively changed
incoming session: runtime activity barriers remain required.

Generic Git configuration queries can return an absent-key exit status after
repository discovery failed. Require `--local` for backend admission so invalid
repository formats cannot be mistaken for the default files backend. Refuse
before allocating native reference parents/locks. This does not qualify later
configuration races, other backends or arbitrary native maintenance.

## Local profile downgrade boundary (ADR-0028)

A framed configuration rejects historical JSON readers before config-dependent
commands can interpret new mappings/state. The current CLI checks the profile
before credential-only and global-skill actions too. Explicit migration preserves
the exact prior document, does not read keys or native context, uses existing
barriers and rechecks the source before atomic publication. Input reads and
serialization are bounded; unsafe files and untrusted diagnostics are refused.
Already-running old processes, malicious header removal/ancestor races and old
commands which never read configuration are not universally fenced. The actual
historical-package drill qualifies seven stopped-profile workflows only; live
cutover, power-loss durability and full historic-format support remain required.

## Client compatibility boundary (ADR-0027)

The required remote client contract prevents accidental old-client use of new
semantics before protected domain access and bootstrap consumption. Authentication
and namespace authorization remain independent. Capability declarations are not
attestation: an authorized malicious client can forge them. Public compatibility
discovery contains no credentials, has a 16 KiB body limit and real-fetch timeout,
and never echoes server/transport diagnostics. Network failures remain retryable.
CLI API calls refuse redirects as well: a successful health handshake does not
authorize forwarding bearer/bootstrap traffic or request bodies to another URL.
This does not fence old offline binaries, retroactively protect local profiles,
or make a rollback to an old Worker safe. Cached handshakes require deployment
discipline and a contract-preserving rollback artifact; historical/local migration,
actual deployed cutover, broader native formats and independent review remain
mandatory release work.

Status: baseline threat model; update with every trust-boundary change
Last updated: 2026-09-05

## Global instruction authority update — 2026-09-08

Encrypted harness namespace access is not sufficient authority to alter native
global instructions. A malicious read/append sandbox can encrypt a new override
or rule, including one the receiver's harness trusts automatically. ADR-0024
requires server-derived immutable `commitMode: replace` for any instruction
entry or tombstone. Validate each chain segment, not merely the final combined
manifest. Bind append ancestry to the authorized immutable predecessor so a
forged snapshot cannot erase the owner's instruction base. Unknown provenance
fails closed for instruction changes; instruction uploads require a server
advertising `commitProvenance: 1` before any objects are published.

This relies on the existing trusted authorization server, not cryptographic
sender signatures. Policies for pre-existing skill/settings authority,
mixed-client fencing, deployed-server qualification and independent review
remain open. A compromised fully authorized device can still publish harmful
instructions. Explicit selection, preview and conflict handling are not a
prompt-injection sanitizer.

Native instruction import graphs are bounded and must stay inside reviewed
roots. External/missing imports fail without reading referenced host files.
No-follow double descriptor reads detect same-size writes despite timestamp
collisions; absence/membership guards detect newly created overrides/rules.
Enumeration errors are redacted and captured plaintext buffers disposed.
These checks and transactional rollback are not an atomic filesystem snapshot
or a proof against all same-UID ABA races.

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

- ADR-0022 profile exclusion uses a dedicated SQLite/kernel mutex for the whole
  operation lifetime and atomic, bounded owner metadata. This prevents two new
  stale reclaimers from stealing each other's lock and releases exclusion on
  process death. Persistent guard inodes are never automatically deleted and
  are excluded from sync. Acquired mutexes are strongly retained until explicit
  release: garbage collection of a suspended continuation must not close its
  native database and silently admit a competing writer. Abandoned ownership
  fails closed until process exit. Mixed old/new local writers, malicious same-principal
  inode replacement and broken network-filesystem locks are outside that
  guarantee; stop old writers before upgrading the local lock format.

- keychain or protected-file credentials for persistent clients;
- explicit native protection (ADR-0021) encrypts the complete local credential
  file with a key held in persistent Secret Service; it never silently changes
  existing file-mode profiles or falls back to plaintext after migration.
  Native helper secrets travel in pipes with bounded runtime/output and an
  environment allowlist. Safe-file checks, cooperative locks and stale-snapshot
  refusal protect migration/update boundaries. Native-key loss requires
  recovery, not deleting the encrypted file. This does not defeat an attacker
  running as the same unlocked OS principal or restoring an older local file.
  macOS now uses a bounded stdin-command Security helper with explicit-keychain
  lookup isolation, no unrestricted-access/overwrite flags and authenticated
  backend identity. Native macOS qualification, recovery/downgrade procedures,
  OS reboot and independent review remain release gates;
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

ADR-0029 additionally reserves a private artifact directory exclusively before
claiming staging/backup children. Failed reservations cannot authorize cleanup
of pre-existing recovery data. Directory identity rechecks and non-recursive,
known-child cleanup preserve observed substitutions and unknown contents. A real
SIGKILL test verifies retained original bytes at one partial-install boundary;
it does not establish automatic replay, power-loss durability or open-descriptor
writer safety. Those gates above remain unchanged.

The ADR-0030 internal file replay coordinator adds a private bounded append
journal and per-target durable intent. Full-scope preflight and per-action
reobservation guard root/artifact identities, prepared/original bytes, partial
rollback and cleanup. Completed commits preserve independently changed destination
files; changed backup content, including an observed original-descriptor write,
is retained. Invalid/out-of-scope journals fail closed with fixed recovery errors.
Journal metadata is device-local plaintext, not an authenticated cloud snapshot.
Normal CLI/Git/profile integration, full low-level fault coverage, ancestry and
check-to-mutation races, power loss, orphan cleanup and malicious local tampering
remain open; the primitive is not an active-writer safety guarantee.

ADR-0031 adds a bounded private original-profile checkpoint and settled decision
receipt. It restricts coordinated profile changes to applied/session-binding
state, installs metadata last, and derives recovery authority from the original
profile when the live file is absent. Exact-file metadata grants do not grant the
profile directory or credential siblings; identity-only workspaces grant no data
authority. Lost journals and mismatched receipts fail closed. Current normal
profile operations are fenced, stale proposals invalidated, and daemon stop uses
validated administrative metadata without authorizing a save. Older binaries,
malicious local writers and full Git/native activity coordination remain outside
this evidence. Profile/journal co-location, complete fault coverage and runtime
enablement remain release requirements.

ADR-0032 separates internal Git preparation from mutation: stage the index and
complete file plan before handing local reference descriptions to a coordinator.
Ref aliases, unsafe observations, duplicate targets and observed writers refuse
handoff. Preparation fetch overrides configured refspecs and preserves FETCH_HEAD;
approved object/shallow-cache acquisition may still occur. No unjournaled native
index lock is held across handoff. The consumer must persist intent and acquire
native exclusion before mutation; the descriptions and guards are not durable
authority, a global snapshot or protection against arbitrary same-user races.

ADR-0033 binds native lock ownership before publication via a private durable
anchor inode and an exclusive hard link, not PID/age heuristics. Exact separately
derived grants, BigInt inode identities, no-follow fixed-marker reads, known link
counts and empty-artifact cleanup refuse foreign/recreated/altered locks. Caller
serialization and durable descriptor publication are mandatory; the primitive
does not authenticate a journal or decide transaction outcome. Production
repository authority/outer-checkpoint integration, pre-publication orphan cleanup,
all power-loss boundaries and arbitrary same-user filesystem races remain open.

ADR-0034 integrates native index ownership into the real profile checkpoint.
Original selected Git roots plus stable re-derived directory/gitfile/commondir
observations supply exact index/lock authority; journal paths cannot grant
themselves access. Native metadata discovery uses no ambient Git routing or
global/system configuration and suppresses raw command diagnostics. Excluded
Git subtrees prevent a broad worktree/Drop root from authorizing sibling metadata.
All lock descriptors precede native publication and survive until durable release.
Held-lock guards also cover caught rollback and restart replay: ownership loss
preserves partial state/evidence rather than attempting unprotected rollback.
This is local observational authority, not journal authentication, atomic CAS,
object/shared-index retention, HEAD/ref recovery or ordinary runtime enablement.
Those requirements and the broader release gates above remain open.

ADR-0035 extends the original-profile-derived authority to exact HEAD, destination
branch, packed-ref, reflog and transaction pin files. Reject stale/unselected
profiles before preparation can fetch; never accept caller-supplied Git grants.
Stable bounded descriptor/named-file checks and fatal control-text decoding avoid
substituted reads and lossy packed-ref rewriting. Pins use durable installed-plan
fingerprints, are preflighted as a set and are retired before native lock release;
foreign pins preserve evidence. The collector marker is not a PID/age lease.
Full object/shared-index closure, arbitrary maintenance/ancestor races, local
configuration changes, prepublication orphans, active-harness barriers and normal
runtime integration remain unqualified. A recoverable decision is not atomic
visibility to uncooperating native readers.

ADR-0036 retains ConfigStore's observed object identity when the encrypted engine
hands off its applied/binding proposal, full workspaces and guarded files. A
hydration selection clone never supplies replacement profile authority: its
proposal derives from the original observed profile and preserves unrelated
mappings/markers. Failed publication restores in-memory values without restoring
invalidated save authority. Per-target native content guards remain in the handoff.
The local identity association is neither authentication nor a global lock.
Normal runtime/activity integration, all historical restore publication faults
and live cross-host/mixed-writer qualification remain open.

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
- ADR-0023 per-field canonical configuration payloads, receiver-owned field
  identities, no raw mixed-authority file transport, guarded syntax-range edits,
  source/inode/root verification and owner-only replacement. Current checks
  detect cooperative mutations, not hostile same-UID check-to-rename races;
  parsed JS strings cannot be zeroized. Local emergency copies may retain
  local-only values for rollback and must never become remote setting objects;
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

## Memory collection transport checkpoint

Memory carries behavioral context, not inert backup data. Each explicit
collection has an independent namespace key and an authenticated encrypted
category/harness/workspace descriptor. Receiving a matching collection ID is
insufficient: descriptor identity and native path policy must match before any
write. Generic Drop restoration must not bypass the memory marker. Selected
roots cannot overlap other collections, Drops, workspaces, another harness,
or reviewed native skill/rule/session/configuration/credential/cache ownership.
Markdown limits and stable no-follow reads are resource/integrity boundaries,
not sanitization of instructions embedded in memory prose.

Session Capsules retain exact memory checkpoints; hydration filters unrelated
local collections before application. Explicit read/append grants may update the
selected memory collection, but do not authorize global instruction changes or
disclose ungranted memory keys. Local scope tests do not qualify live capability
revocation, native effective recall, filesystem alias races, complete native
format coverage or mixed-client fencing. These remain release obligations.

Memory enrollment validates before persisting selection and never changes native
settings, grants remote keys, or moves files. All config saves now check memory
ownership, including inverse collisions introduced through ordinary Drop or
workspace commands. A short-lived kernel mutex plus the fingerprint observed at
load time prevents cooperating current-version CLI/daemon writers from silently
overwriting stale configuration. Contention/change is exit `5`, with no automatic
field merge. Old binaries and arbitrary same-user file editors do not participate
in this lock; mixed-client fencing and broader local-filesystem races remain
open. Configuration persistence is not atomic with an earlier remote mutation;
an error must not trigger blind retries of destructive/ambiguous operations.

Typed session memory references authenticate logical identity through the encrypted
session and existing collection descriptor; they are not authority to access an
unbound root. Wrong-project, missing-ID, ambiguous-root and unsafe-path cases fail
before native writes with a fixed redacted error. Only reviewed structured tool
path fields are converted; prose, tool results and authored content are historical
data, not filesystem mapping instructions. Bounded record traversal and staging
cleanup constrain malformed inputs. Relative/opaque reference closure, historical
migration, physical aliases and old-client fencing remain open release obligations.

Canonical relative memory references use only explicit native record cwd, not
prompt text or Statecase's current directory. Reject missing/invalid metadata,
wrong collection ownership and noncanonical spellings that could conceal alias
semantics. Convert before workspace URI rewriting and retain source-local
activity evidence for dependency checks. This lexical policy does not prove
physical path identity or close the remaining opaque/migration/version gates.

A successful push records the native captured complete-prefix digest as its
applied-file baseline, independently of the portable object's content digest.
Hashing a later live-file version would improperly authorize overwriting work
never uploaded. Tests mutate the source during upload and add complete edits or
incomplete tails before/after capture; return pull must preserve those bytes and
refuse the conflicting transaction. A native representation change alone is not
an edit when the original captured native prefix is still exactly present.

Raw memory patches use a whole-envelope parser shared with activity extraction.
Only actual validated file/move headers can authorize logical reference mapping;
added/deleted/context text cannot. Reject controls/overlong paths, malformed
bodies and ambiguous move placement; validate before invoking any mapper.
Preserve authored hunks and line endings exactly. With a selected source memory
collection, an unsupported raw patch cannot silently omit relative dependencies.
This reviewed grammar does not establish arbitrary freeform/shell closure,
physical alias identity or historical/mixed-client compatibility.

Ordinary file preflight now captures bounded descriptor digests and native/parent
identities and rechecks them at each precommit boundary (ADR-0026). Detect later
creation, modification, deletion and alias substitution before that write;
rollback preserves earlier destinations and leaves applied state unchanged.
These observations do not change generic Drop permissions or weaken the stricter
native context policy. They do not exclude a race after the final check, writes
through old open descriptors, ancestors above the selected root or process-death
recovery; those remain release gates.

Concurrent native history equivalence maps only reviewed memory path fields and
patch headers to authenticated logical identities. Each stream tracks its own
native cwd; content and record order/multiplicity remain exact. Unknown
references, malformed/incomplete records and changed authored content fail the
proof, including in otherwise unmatched remote suffixes. This is not authority
to rewrite portable history or access an unbound collection.
