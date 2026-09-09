# ADR 0006: Hybrid content chunking

Status: accepted
Date: 2026-09-05
Owners: Statecase maintainers
Test IDs: SY-001 through SY-010, AD-CX-003 through AD-CX-008

## Context

Large ordinary files benefit from content-defined chunking after insertions,
while append-only JSONL sessions benefit from complete-record boundaries.
Compressed or already encrypted content rarely deduplicates internally.

## Decision

Use complete JSONL record boundaries for recognized append streams. Use a
FastCDC-style content-defined splitter for ordinary files with 1 MiB target,
256 KiB minimum, and 4 MiB maximum chunks. Use fixed 4 MiB chunks for formats
classified as already compressed or encrypted. Stream every strategy with
bounded memory.

## Alternatives considered

- Fixed chunks for everything: simpler, but a small insertion invalidates the
  remainder of large files.
- Content-defined chunks for everything: wastes CPU and ignores safe append
  semantics.
- Whole-file objects: unacceptable incremental behavior for sessions.

## Consequences

Chunking policy becomes part of manifest compatibility. Classification errors
affect efficiency, not integrity, because plaintext digests and AEAD still
validate reconstructed bytes.

## Security and privacy impact

Chunk boundaries and sizes are visible as encrypted-object metadata. Scope
keyed object IDs prevent cross-vault confirmation attacks.

## Compatibility and migration

Manifests record strategy and parameters. Future strategies receive new IDs;
old readers continue reconstructing existing chunks.

## Verification

Boundary property tests, one-byte insertion tests, incomplete JSONL-tail tests,
large-file memory tests, and exact reconstruction vectors must pass.
