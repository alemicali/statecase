# Statecase operations

Status: deployed service
Last verified: 2026-09-06

Current Worker version: `1957598c-cf58-42e6-88a9-9ebc95d9babf`.
Remote D1 migrations through `0004_capabilities.sql` are applied. The live
health endpoint advertises scoped protocol `1.1` and legacy migration protocol
`1.0`.

## Remote inventory

| Component | Resource |
| --- | --- |
| Worker | `statecase-api` |
| HTTPS API | `https://statecase-api.hi-0e6.workers.dev` |
| D1 | `statecase` / `e92ffa3c-dff8-4740-afe2-f7e84081b2b2` |
| R2 | `statecase-vaults` |
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
npx wrangler d1 migrations apply statecase --remote --config apps/cloud/wrangler.jsonc
npm run cloud:deploy
curl --fail https://statecase-api.hi-0e6.workers.dev/health
```

After deployment, verify that an invalid bootstrap redemption returns `401`
with both `Cache-Control: no-store` and `Pragma: no-cache`, and that a protected
namespace revision request without authorization returns `401`.

Run migrations before deploying code that requires them. Wrangler versions are
locked. Never inject the production Better Auth secret into tests or `.dev.vars`.

## Local Worker

Copy `.dev.vars.example` to ignored `.dev.vars`, replace only the placeholder
secret, and run `npm run cloud:dev`. Local D1/R2/DO data lives under the ignored
Wrangler directory.

## Rollback and recovery

Cloudflare Worker versions can be rolled back from deployment history. Do not
roll D1 backward destructively; ship a forward migration. R2 objects and
Durable Object revisions are immutable/append-only in the current release. If a deploy is
unhealthy, roll back the Worker version first, freeze new writes if necessary,
and preserve D1/R2 evidence.

The current release has no garbage collector, so an aborted upload may
leave unreachable encrypted objects but cannot delete reachable content.
