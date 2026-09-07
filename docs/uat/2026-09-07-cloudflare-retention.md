# Cloudflare retention deployment and UAT — 2026-09-07

Status: deployment verified; isolated destructive path passed; aged live
destructive fixture remains open

Commit: `a6230cc5932a7d767f74d0b183f5e98d766fc13b`

Worker version: `e9b7158e-b05a-441a-a807-412d40661858`

## Scope

Qualify the production retention deployment without listing or deleting an
existing user's vault. Exercise authenticated R2 deletion in the real workerd,
Durable Object, and R2 implementation under an isolated test environment. Keep
the 30-day production grace period unchanged.

## Automated and isolated destructive evidence

The release commit passed:

- `npm run check`: 354 tests; 93.28% statements, 90.05% branches,
  91.65% functions, and 95.71% lines;
- retention selector: 100% statements, branches, functions, and lines;
- `npm run cloud:test`: 11 workerd tests;
- Docker-isolated `npm run check` plus `npm run cloud:test`;
- GitHub CI quality and compatibility jobs on Node.js 22 and 24.

The workerd UAT creates an allowlisted disposable owner, device, and vault. It
writes a reachable namespace manifest and chunk, an unreachable scoped object,
a legacy object, and a malformed shadow R2 key. Dry-run reports only the exact
unreachable canonical object and does not mutate it. Collection deletes that
object while the reachable manifest/chunk, legacy object, and malformed key
remain readable. Coordinator tests additionally cover protected snapshots,
recursive Session Capsule pins, append parents, grace and pre-tracking objects,
100,001-record bounds, revision-ID reuse, live lease contention, expired-lease
takeover, and metadata pruning.

## Live Cloudflare evidence

`wrangler deploy` installed:

- Worker `statecase-api` with D1, R2, and Durable Object bindings;
- `STATECASE_GC_GRACE_DAYS=30`;
- cron schedule `17 3 * * *` (03:17 UTC daily);
- version `e9b7158e-b05a-441a-a807-412d40661858`.

After deployment:

- `GET /health` returned HTTP 200 with service `statecase`, status `ok`,
  protocol `1.1`, and legacy protocol `1.0`;
- anonymous `POST /v1/vaults/vlt_nonexistent/garbage-collection` returned HTTP
  401 and `AUTH_REQUIRED`;
- the browser root rendered the minimal Statecase enrollment UI;
- the existing production allowlist and 30-day grace were not weakened.

## Deliberately unclaimed boundary

No existing production vault or R2 prefix was inspected or mutated. A live
destructive test needs a dedicated authenticated disposable vault containing an
object whose server upload time is older than 30 days, or a separate temporary
Cloudflare test stack. Until that fixture exists and is cleaned up explicitly,
the live 30-day deletion drill remains a release gate. The isolated workerd
test proves the implementation path but is not represented as aged production
evidence.
