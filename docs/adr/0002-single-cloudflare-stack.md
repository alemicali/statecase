# ADR 0002: Single Cloudflare release stack

Status: accepted and amended 2026-09-06
Date: 2026-09-05
Owners: Statecase maintainers
Test IDs: CF-001 through CF-012, UAT-01, UAT-06, UAT-07

## Context

The initial release needs a hosted API and durable metadata/object storage,
but separate remote development, staging, and production stacks add operational
work before the protocol is fully qualified. Local development provides
isolation for the contract and integration suites.

## Decision

Provision one remote release stack in the existing Cloudflare account:

- Worker `statecase-api`, running the Hono API;
- R2 bucket `statecase-vaults`, storing ciphertext objects and encrypted
  manifests;
- D1 database `statecase`, storing control-plane metadata;
- one Durable Objects namespace, with one logical coordinator per `vaultId`.

Use Wrangler/local emulation for development and tests. Do not encode release
stage in resource or service names; the deployed artifact version and release
metadata carry that information. Do not provision a remote staging stack until
the public-launch promotion policy requires it. Resource IDs and secrets remain
environment configuration rather than protocol or domain constants.

## Alternatives considered

- Separate remote dev, staging, and production resources: stronger isolation,
  but disproportionate initial operating cost.
- Separate production account: appropriate before public launch, premature for
  the current allowlisted service.
- Release-stage suffixes in resource names: rejected because stage belongs in
  versions and deployment metadata, and renaming creates needless client churn.

## Consequences

Provisioning and migrations stay simple. Remote acceptance tests use a
disposable account and uniquely generated vaults, never global cleanup against
shared data. Environment isolation must be revisited before a public launch.

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
- Remote acceptance tests clean only the exact disposable state they created.
- CI rejects Cloudflare credentials and hard-coded secrets.
