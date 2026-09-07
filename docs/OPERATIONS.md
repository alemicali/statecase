# Statecase operations

Status: deployed service
Last verified: 2026-09-07

Current Worker version: `e9b7158e-b05a-441a-a807-412d40661858`.
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

The Worker runs reachability garbage collection daily at 03:17 UTC. The
production grace period is configured as 30 days. Inspect the same plan without
mutation before an operator-triggered run:

```bash
statecase --json retention plan
statecase --json retention collect --yes
```

Collection preserves current heads, 24 hourly/30 daily/12 monthly UTC
checkpoints, protected snapshots, recursive Session Capsule revision pins, and
append-delta parents. It skips legacy objects, objects uploaded before tracking
began, and any namespace with incomplete historical metadata. `GC_BUSY` is a
bounded retry condition while R2 deletion holds the vault lease. If it persists
after the reported lease interval, rerun `retention collect --yes`: collector
takeover is the only operation allowed to clear an expired lease, so a possibly
still-running deletion can never race a commit. Never delete the R2 vault
prefix manually; doing so bypasses reachability, grace, and the commit exclusion
lease.

For an application-data recovery, inspect a historical namespace in staging or
preview a supported in-place restore first:

```bash
statecase --json restore --revision <revision-id> --mapping <mapping-id> --target <staging-dir> --dry-run
statecase --json restore --revision <revision-id> --mapping <mapping-id> --in-place --dry-run
```

In-place mode currently supports two-way Drops and stopped Codex/Claude
mappings on full-key devices. Stop the daemon and affected harness, then run
the approved command with `--yes`. Record the emitted protected snapshot ID and
local emergency snapshot path. To recover the exact pre-restore local paths,
keep those processes stopped and use:

```bash
statecase --json emergency rollback <emergency-snapshot-path> --yes
```

This emergency rollback is local and offline. Do not hand-edit the snapshot;
all file backups are verified before any rollback mutation. Workspace in-place
restore is not yet supported.

The deployment and retention qualification record is
[2026-09-07 Cloudflare retention UAT](uat/2026-09-07-cloudflare-retention.md).
The packaged Drop recovery path is qualified in the
[2026-09-07 Daytona and Cloudflare in-place restore UAT](uat/2026-09-07-in-place-restore-daytona.md).
