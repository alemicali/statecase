# Statecase repository instructions

These instructions apply to the entire repository.

## Product state

- Statecase is a standalone greenfield product. It has no AgentStash,
  ClawStash, or Restic compatibility requirement in the initial release.
- The repository is a TDD product under release qualification. Never claim a
  feature is implemented unless linked tests demonstrate it.
- Read the product strategy, implementation specification, test/UAT plan,
  threat model, readiness review, and accepted ADRs before implementation.
- External copy says "agents," not "coding agents." Codex and Claude are the
  initial adapters, not the brand boundary.

## Safety

- Never read or test against a real `~/.codex`, `~/.claude`, `~/.statecase`,
  keychain, backup repository, or cloud bucket. Use explicit temporary fixtures.
- Never commit credentials, session transcripts, prompts, personal paths, Git
  credentials, encryption material, or unredacted diagnostics.
- Restore, deletion, retention, garbage collection, device revocation, and
  materialization require preview and rollback tests.
- Preserve unknown native harness state and fail closed for unsupported
  formats.

## Architecture boundaries

- Protocol, domain, and crypto packages do not import CLI, Hono, Cloudflare,
  or harness-specific code.
- Apps may compose packages; packages never import from apps.
- Hono owns Worker HTTP routing, Durable Objects own ordered vault decisions,
  R2 owns immutable encrypted objects, and D1 owns small control metadata.
- Absolute paths are local mappings, never global identity.
- Git is the source baseline; Statecase synchronizes encrypted overlays, not
  `.git` object databases.
- Skills invoke stable CLI JSON contracts and are never persistence machinery.

## Required process

1. Link work to a test ID or add one.
2. Write the failing test first.
3. Implement the smallest passing behavior.
4. Add boundary and failure tests.
5. Run `npm run check`.
6. Update relevant docs, ADRs, fixtures, schemas, and changelog.

New critical code targets at least 90% branch coverage. Bugs require regression
tests. Do not lower coverage thresholds to merge a change.
