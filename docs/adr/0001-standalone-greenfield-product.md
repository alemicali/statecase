# ADR 0001: Standalone greenfield product

Status: accepted
Date: 2026-09-05
Owners: Statecase maintainers
Test IDs: IS-001 through IS-005, UAT-10

## Context

AgentStash is a Restic-based backup product. Statecase is an ordered,
merge-aware, end-to-end encrypted synchronization system for portable agent
context. Reusing the old repository would preserve a package identity but
would not provide meaningful implementation leverage, while coupling products
with different data models, trust boundaries, failure modes, and release
cadences.

## Decision

Build Statecase from scratch in a new standalone repository and npm-workspaces
monorepo. Do not copy or depend on AgentStash, ClawStash, Restic, or their
configuration and storage formats. The new repository owns its CLI, package
identity, local directories, service names, protocol, cloud resources, and
release history.

Existing tools may be studied as prior art. Any future code adoption requires
license and provenance review; any future data importer requires a separate ADR
and is outside the initial release.

## Alternatives considered

- Evolve AgentStash in place: preserves branding and release history but adds
  legacy complexity without enough reusable sync code.
- Place a greenfield core beside a legacy package in the AgentStash repo:
  technically possible, but still couples governance, packaging, CI, and user
  expectations.
- Use ClawStash as a dependency: rejected because backup primitives do not
  supply the required synchronization protocol.

## Consequences

The architecture and version line begin cleanly, with no compatibility burden.
We must establish new distribution and product recognition. AgentStash users
do not receive an automatic migration path in the initial release.

## Security and privacy impact

Separate configuration, credentials, process names, and cloud prefixes reduce
cross-product mistakes. Statecase setup and uninstall must never inspect or
modify unrelated backup repositories.

## Compatibility and migration

There is no product migration in the initial release. Protocol and schema evolution begin
at Statecase version 1. A future one-way importer must be previewed, copy-only,
and separately reviewed.

## Verification

- IS-001 through IS-005 verify dependency, path, credential, service, runtime,
  and uninstall isolation.
- UAT-10 runs Statecase beside realistic AgentStash and ClawStash fixtures.
- Dependency and secret scans reject accidental legacy coupling.
