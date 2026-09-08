# ADR 0027: Required client/service contract

Status: accepted; implemented locally, deployment qualification pending
Date: 2026-09-08
Test IDs: PR-014, AU-004, SK-001

## Context

Transport generation 1.1 alone does not identify whether a binary understands
namespace provenance, native context, memory references or late-write guards.
Old binaries could otherwise read and publish new state while ignoring required
semantics. Failing-first tests reproduced successful object/control operations
without a client contract and new-client requests against a legacy health response.

## Decision

Use one service-wide client contract revision, initially `1`. Every protected
request declares `x-statecase-client-contract: 1` and a comma-separated
`x-statecase-capabilities` containing all four required names:

- `namespace-provenance-v1`
- `native-context-v1`
- `memory-references-v1`
- `local-write-guards-v1`

The Worker authenticates `/v1/*` first, then validates compatibility before
route authorization, body parsing, object access or domain mutation. Missing,
unknown contract versions or missing required capabilities receive HTTP 426
with `CLIENT_UPGRADE_REQUIRED` and a fixed, non-cacheable diagnostic. Authentication
continues to return 401 independently of compatibility. For public bootstrap
redemption, compatibility precedes token parsing/consumption. Auth/session
maintenance performed by the authentication provider is not a domain-mutation
guarantee. UI assets, `/health` and `/api/auth/*` are exempt; browser login and
device approval do not implement a second synchronization client.

Capability headers are at most 2,048 characters and 32 unique validated names.
Optional future names and comma whitespace are allowed; duplicates and malformed
names are rejected. Contract versions are canonical strings, not permissive
numeric coercions. These declarations are compatibility checks, **not** identity,
authorization, cryptographic attestation or evidence that a malicious client
actually implements the advertised behavior.

Public `/health` advertises protocol 1.1, legacy stored-data protocol 1.0 and
`compatibility: { minimumClientContract: 1, maximumClientContract: 1,
requiredCapabilities: [...] }`, with `Cache-Control: no-store`.

Before its first `/v1/*` or `/api/bootstrap/redeem` operation, each CLI HTTP client
fetches `/health` without bearer credentials or request body. Redirects are
refused; the real fetch has a ten-second timeout including body consumption.
The reader retains at most 16 KiB and rejects malformed UTF-8/JSON, absent
contract metadata, incompatible protocol generations/ranges and unknown required
capabilities. Optional fields and future minor protocol versions are ignored.
No untrusted health body or underlying transport exception enters diagnostics.
All CLI API requests also refuse HTTP redirects. A real loopback HTTP regression
reproduced a 307 forwarding a synthetic bootstrap body to an unexpected endpoint;
the client must not follow it, including a same-origin redirect. Browser UI
navigation is a different surface and is unaffected. Transport refusal is an
ambiguous network outcome, not proof that the original endpoint did not redeem.

A successful handshake is cached per client instance and concurrent operations
share it. Failure clears the cache; a protected HTTP 426 invalidates it for the
next request. Every protected request still carries the declaration so an
upgraded Worker can reject a long-running daemon immediately. Network/failing
stream errors, HTTP 429 and service 5xx remain retryable exit 7. Missing or invalid
compatibility and protected HTTP 426 are integrity/compatibility exit 6. A new
failing-first test exposed a disconnected body misclassified as incompatibility;
the stream failure now preserves the redacted network classification.

## Alternatives and cost

Per-namespace negotiated floors would allow a mixed fleet but require durable
feature state, capability-aware migration and enforcement at every old/new
entrypoint. That remains a possible later design, not an implicit property of
the current private service. A package-version string alone is not a protocol
contract. Relying only on manifest readers would allow destructive old writers
to reach the cloud first. Checking health before every chunk adds unnecessary
latency and still cannot make an old rolled-back Worker enforce a new contract.
The chosen gate costs one small public request per client instance, no new
Cloudflare resource, no D1 migration and no encrypted-object rewrite.

## Migration and rollback limits

This is a coordinated private-service cutover, not an unattended rolling upgrade.
The last deployed Worker does not advertise this contract, so this CLI refuses
protected operations against it. Stop synchronization clients/services, qualify
and deploy the matched Worker/CLI pair, verify the actual deployed health and
old-client refusal, then resume upgraded clients. Preserve native/local state
and recovery material throughout. No deployment was performed by this change.

Do not mix old/new Worker versions or roll the Worker back to one without this
gate after enabling new clients. A cached handshake cannot prevent such a
downgrade; an old Worker cannot enforce new headers. Roll back only to a
qualified contract-preserving artifact or keep synchronization stopped while
repairing forward. An incident plan must account for clients outside operator
control before any public rollout.

Stored transport 1.0 data remains on the existing authenticated migration path;
the gate refuses old software, not all old ciphertext. It does not prove full
history migration, automatic native memory support or every harness version.
It also cannot stop an old **offline** executable from opening and editing an
existing local profile/native file. Local profile fencing with real old packages,
historical upgrade/downgrade tests and independent-host/live-cloud qualification
remain mandatory release gates. Do not describe header spoofing resistance or
arbitrary local downgrade safety as implemented.

## Verification

Protocol tests cover exact versions, missing/duplicate/malformed/oversized
capabilities, required/optional fields and parity with standalone UAT headers.
Client tests cover no-secret public handshake, concurrent cache reuse, invalidation,
retry, exact 16 KiB boundary, cancellation, UTF-8 and redacted errors. CLI JSON
bootstrap tests verify exit 6, unchanged configuration/credentials, no secret
transmission and preserved token input on compatibility refusal.

The Hono test inventories every actual protected route and verifies refusal
before coordinator, authorization and control calls, including malformed bodies.
The real local workerd suite rejects device and capability requests without R2
object or coordinator-head changes, preserves a D1 single-use grant after an
old-client attempt, then redeems it exactly once with the current contract.
Authentication without contract headers and unauthenticated 401 ordering remain
covered. Existing native and background drills must pass with the matched pair;
they do not replace actual historical-binary or deployed cutover evidence.
