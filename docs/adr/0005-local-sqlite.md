# ADR 0005: Local SQLite implementation

Status: accepted
Date: 2026-09-05
Owners: Statecase maintainers
Test IDs: RT-004 through RT-009, SY-009, SY-010

## Context

The client requires a crash-safe journal, device mappings, applied revisions,
leases, resumable transfers, and conflict records. Node's built-in SQLite API
is still changing across supported runtimes.

## Decision

Use `better-sqlite3` behind a small Statecase-owned storage interface. Enable
WAL, foreign keys, a bounded busy timeout, schema migrations, and explicit
transactions. Never synchronize the Statecase database itself.

## Alternatives considered

- `node:sqlite`: avoids a dependency but has a less mature compatibility
  contract across the supported Node range.
- libSQL embedded: adds remote/database semantics the local journal does not
  need.
- JSON files: insufficient transactional behavior under crash and concurrency.

## Consequences

The CLI has a native dependency and release builds need supported platform
artifacts. Docker and CI test clean install paths on Node 22 and 24.

## Security and privacy impact

The database contains metadata and may contain encrypted cached envelopes, but
not persisted vault root keys. File permissions are owner-only where supported.

## Compatibility and migration

Migrations are monotonic, transactional, and recorded in `schema_version`.
Downgrade never silently opens a newer schema.

## Verification

Crash replay, two-process locking, migration fixtures, disk-full behavior, and
Docker install tests must pass.
