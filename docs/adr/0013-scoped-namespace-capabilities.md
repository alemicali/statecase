# ADR 0013: Namespace heads and scoped ephemeral capabilities

Status: accepted and implemented for current-head synchronization

## Context

The legacy alpha stores one encrypted manifest and one head for an entire
vault. Because the Worker cannot decrypt that manifest, it cannot prove which
workspace, Drop, or harness a client changed. Issuing a token described as
"workspace scoped" against that protocol would therefore be misleading: the
token could replace the vault-wide head or fetch any vault object whose opaque
ID it learned.

Ephemeral sandboxes require materially narrower authority than a persistent
device. The required grant is short-lived, single-use for bootstrap, restricted
to explicit namespaces and `read`/`append`, incapable of accessing the secrets
category, and independently revocable.

## Decision

Protocol 1.1 introduces atomically committed namespace heads. Each namespace
has its own revision and encrypted manifest object. Encrypted data objects are
stored under a namespace-qualified R2 key, so authorization is enforced before
the object lookup and ciphertext from another namespace is not reachable
through an allowed route. A Durable Object checks every touched namespace base
before changing any head; disjoint namespace writers can advance independently.

Append commits contain blinded immutable patch-record identities. The
coordinator retains those identities and rejects their reuse without learning
plaintext paths. A patch may propose an upsert or deletion of a logical path,
but it cannot perform a server-authorized replace: readers reconstruct the
authenticated parent chain and a persistent writer reconciles the proposal.

Capability enrollment has two credentials:

1. a high-entropy `stc_boot_...` secret whose SHA-256 digest is stored and
   which can be redeemed exactly once with an atomic conditional D1 update;
2. a separate high-entropy `stc_access_...` bearer credential, also stored only
   as a digest, that carries the remaining grant lifetime.

The creator supplies an opaque client-encrypted scope-key envelope. Cloudflare
never receives plaintext vault or scope keys. Grants expire within 24 hours,
allow only `read` and/or `append`, reject `secrets` namespaces, deny legacy
vault-wide endpoints, and are revoked together with their access sessions.
Revoking the creator device also revokes its grants. Redemption responses use
`Cache-Control: no-store`.

## Consequences

The existing protocol 1.0 paths remain temporarily available to persistent
devices so current private data can be migrated. A capability never falls back
to them. The CLI emits per-namespace snapshot/delta manifests, derives and
wraps only granted scope keys, creates new `0600` bootstrap files, and migrates
the first legacy head into namespace-qualified storage. Each immutable
namespace revision records its predecessor so bounded clients can reconstruct
append chains. Protected snapshots now pin scoped global revisions; retention
compaction and real sandbox/harness certification remain separate release gates.

R2 requires a known upload length. The Worker therefore reads each already
bounded object into at most 8 MiB before the conditional put; this fixes the
legacy transform-stream behavior that failed in real workerd/R2 despite passing
the in-memory API tests.

## Verification

Protocol and coordinator tests cover duplicate namespace/path claims, atomic
multi-head commits, disjoint writers, stale touched heads, durable idempotency,
and append reuse. The CLI UAT covers trusted publish, redacted capability
creation, rootless bootstrap, scoped pull, append publish, persistent-device
reconciliation, and revocation. The workerd suite exercises D1 migration, concurrent one-time
redemption, scoped R2 access, legacy and cross-namespace denial, append commit,
replace denial, and immediate revocation using the real Worker bindings.
