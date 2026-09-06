# Private MVP operations

Status: deployed private stack
Last verified: 2026-09-06

Current Worker version: `3c9b903e-30cb-43d0-9325-6e73d8501ce1`.
Remote D1 migrations through `0003_device_sessions.sql` are applied.

## Remote inventory

| Component | Resource |
| --- | --- |
| Worker | `statecase-api-mvp` |
| HTTPS API | `https://statecase-api-mvp.hi-0e6.workers.dev` |
| D1 | `statecase-mvp` / `dda02c36-f32b-458a-89b9-e3ed395a1482` |
| R2 | `statecase-mvp` |
| Durable Objects | binding `VAULTS`, class `VaultCoordinator` |

The Worker secret `BETTER_AUTH_SECRET` is managed by Cloudflare and is not in
the repository. Private signup is allowlisted by `STATECASE_ALLOWED_EMAILS`.

## Local verification

```bash
npm ci
npm run check
npm run cloud:test
docker compose -f compose.test.yaml run --rm --build test
```

All automated filesystem tests use temporary synthetic homes. The Docker
service copies the repository into its image and mounts no host harness roots.

## Deploy

```bash
npm run cloud:types
npx wrangler d1 migrations apply statecase-mvp --remote --config apps/cloud/wrangler.jsonc
npm run cloud:deploy
curl --fail https://statecase-api-mvp.hi-0e6.workers.dev/health
```

Run migrations before deploying code that requires them. Wrangler versions are
locked. Never inject the production Better Auth secret into tests or `.dev.vars`.

## Local Worker

Copy `.dev.vars.example` to ignored `.dev.vars`, replace only the placeholder
secret, and run `npm run cloud:dev`. Local D1/R2/DO data lives under the ignored
Wrangler directory.

## Rollback and recovery

Cloudflare Worker versions can be rolled back from deployment history. Do not
roll D1 backward destructively; ship a forward migration. R2 objects and
Durable Object revisions are immutable/append-only in the MVP. If a deploy is
unhealthy, roll back the Worker version first, freeze new writes if necessary,
and preserve D1/R2 evidence.

The current private MVP has no garbage collector, so an aborted upload may
leave unreachable encrypted objects but cannot delete reachable content.
