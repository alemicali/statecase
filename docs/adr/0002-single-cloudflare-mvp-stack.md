# ADR 0002: Single Cloudflare stack for the MVP

Status: accepted
Date: 2026-09-05
Owners: Statecase maintainers
Test IDs: CF-001 through CF-012, UAT-01, UAT-06, UAT-07

## Context

The MVP needs a hosted API and durable metadata/object storage, but separate
remote development, staging, and production stacks would add operational work
before the protocol is validated. Local development provides isolation for the
contract and integration suites.

## Decision

Provision one remote MVP stack in the existing Cloudflare account:

- one Worker running the Hono API;
- one R2 bucket storing ciphertext objects and encrypted manifests;
- one D1 database storing control-plane metadata;
- one Durable Objects namespace, with one logical coordinator per `vaultId`.

Use Wrangler/local emulation for development and tests. Do not provision a
remote staging stack during the MVP. Remote resource names contain `mvp`, and
resource IDs and secrets remain environment configuration rather than protocol
or domain constants.

## Alternatives considered

- Separate remote dev, staging, and production resources: stronger isolation,
  but disproportionate MVP cost.
- Separate production account: appropriate before public launch, premature for
  a private MVP.
- A production-labeled first stack: rejected because it would imply readiness
  that has not passed recovery and security gates.

## Consequences

Provisioning and migrations stay simple. Remote tests and MVP users share a
stack, so tests use disposable uniquely prefixed vaults and may never run a
global destructive cleanup. Environment isolation must be revisited before a
public launch.

## Security and privacy impact

The single stack has a larger blast radius than separated environments. Only
E2EE ciphertext payloads reach R2. Test principals, vaults, tokens, and object
prefixes remain distinct. Secrets use Cloudflare secret bindings and are never
committed.

## Compatibility and migration

Client endpoints and bindings are configuration. Vault IDs, object keys,
manifests, and cryptographic identities do not encode Cloudflare account or
environment IDs, allowing a later split without a protocol revision.

## Verification

- Contract tests run against the reference server and local Workers runtime.
- Smoke tests validate Worker-to-D1, Worker-to-R2, and Worker-to-Durable-Object
  bindings.
- Remote smoke tests clean only the exact disposable namespace they created.
- CI rejects Cloudflare credentials and hard-coded account/resource IDs.
