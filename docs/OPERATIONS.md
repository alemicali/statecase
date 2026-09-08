# Statecase operations

Status: deployed service
Last deployment verified: 2026-09-08

Last verified Worker version: `9d4c611d-ad57-485c-a627-bb6c26892710`
(see the [live rotation report](uat/2026-09-08-key-rotation-daytona.md)).
Remote D1 migrations through `0005_vault_key_epochs.sql` are applied. The live
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

## Lost-device revocation and key rotation

Device revocation is an access-control action; complete the cryptographic part
for every vault the device could access. From a remaining owner installation:

```bash
statecase --json device list
statecase --json device revoke <lost-device-id> --yes
read -rsp 'New recovery passphrase: ' STATECASE_RECOVERY_PASSPHRASE && export STATECASE_RECOVERY_PASSPHRASE
printf '\n'
statecase --json vault key rotate --recovery-file /secure/new.statecase-recovery.json --yes
statecase --json sync
unset STATECASE_RECOVERY_PASSPHRASE
```

`device revoke` reports `keyRotationRequired: true`. Rotation must return the
next `keyEpoch`, `rotated: true`, and a `recoveryFile`; `rekeyPending: true`
means configured namespaces still need the following trusted sync. Do not
overwrite a recovery artifact. Do not delete the previous kit until an active
peer has ingested the new envelope and a clean replacement has recovered with
the new kit. Keep all recovery files outside synchronized roots and ordinary
cloud drives.

An active pre-exchange-key installation blocks rotation rather than being
silently omitted. Run `statecase login` again on that installation to publish
its exchange public key, or explicitly revoke it if it is no longer trusted.
A replacement device must use the current kit; a stale kit exits with integrity
code `6`, does not add vault membership, and does not become local key authority.

If the POST response is lost, the CLI reads the authoritative epoch and opens
its own envelope. A matching candidate key completes the command with
`reconciled: true`. If that proof is unavailable, the command exits `7`, keeps
the candidate recovery kit at the reported path, and leaves local credentials
at the prior epoch. Do not rotate again blindly: restore connectivity and run
`statecase --json sync`; it retrieves the committed envelope if the rotation
won. Existing scoped capability grants and redeemed sessions are revoked by the
same D1 transaction and must be reissued only after namespace rekeying.

An offline trusted installation can catch up through several rotations with
one normal `sync` or `pull`. The CLI authenticates every missing envelope in
order and saves the complete keyring once. Missing, forged, out-of-order, or
regressing history fails closed; credentials and synchronized files remain at
their previous state. Retrying after the history is available is safe. A lost
rotation response is reconciled against that exact proposed epoch, even when
the service has already advanced again; the next sync ingests the newer epochs.
The current CLI/recovery format retains a contiguous history of at most 1,000
epochs. Do not prune historical keys manually: immutable revisions require them.

The coordinator durably fences the old write epoch before sending D1 a
rotation. If D1 has not completed it (for example, membership changed after
preflight), commits remain blocked even after a service restart. Once the
recipient set is corrected and connectivity restored, an authorized owner
can complete a rotation to that same next epoch using a fresh recovery-file
path. Do not erase the previous candidate kit while its outcome is unknown,
and never lower or manually delete the coordinator's epoch floor.

The limitation is explicit: rotation prevents the revoked device from
decrypting data first written under the new epoch, but cannot erase plaintext,
old keys, or ciphertext it already copied.

## Local verification

### Native service runtime

`statecase daemon install` pins the current Node executable. Reinstall the
definition and stop/start the service after replacing/removing that Node installation; the service manager
does not load nvm or your interactive shell startup files. Linux definitions
retain their filesystem hardening and require configured writable roots to be
available. `statecase daemon status` uses owner-only local IPC.

The [Linux lifecycle drill](uat/2026-09-08-native-systemd.md) passed with isolated
fixtures. The [macOS lifecycle drill](uat/2026-09-08-native-launchd.md) passed
on macOS 26.6.2 arm64 / Node 24.20.0. Authenticated background convergence and sleep/boot behavior
remain release gates. Use `statecase daemon start|stop|status` after installation.
Start/stop are idempotent and verify the installed profile and loaded definition.
Linux stop preserves autostart; macOS stop unloads the job so KeepAlive cannot
respawn it. A different STATECASE_HOME cannot control the single native service
slot for this OS user. To switch profiles, uninstall from the old profile first.
JSON `requested: true` acknowledges a manager operation, not synchronization
success. Use status to inspect the daemon. Do not use the fixture drill on a
manager with an existing unit.

### Automated suites

```bash
npm ci
npm run check
npm run cloud:test
npm run uat:background
docker compose -f compose.test.yaml run --rm --build test
```

All automated filesystem tests use temporary synthetic homes. The Docker
service copies the repository into its image and mounts no host harness roots.

The background UAT builds on a previously built CLI. It starts a local Worker
with isolated D1/R2, creates synthetic device credentials, and runs two real
daemon processes through per-device loopback proxies. It injects SIGKILL and
network failures, then stops only its owned process groups and removes its
temporary credentials, profiles, database, and objects. It does not provision
Cloudflare resources or touch real agent state.

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
restore additionally preserves Git HEAD/ref identity, the raw index, and the
affected worktree paths; initialized submodule worktrees fail closed.

The deployment and retention qualification record is
[2026-09-07 Cloudflare retention UAT](uat/2026-09-07-cloudflare-retention.md).
The packaged Drop recovery path is qualified in the
[2026-09-07 Daytona and Cloudflare in-place restore UAT](uat/2026-09-07-in-place-restore-daytona.md).
