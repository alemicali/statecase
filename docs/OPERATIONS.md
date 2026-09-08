# Statecase operations

Status: deployed service
Last deployment verified: 2026-09-08

Last verified Worker version: `3460deaa-bf3c-4244-bc13-9f0979b521b3`
(see the [packaged cross-peer Claude report](uat/2026-09-08-cloud-native-claude.md)).
Remote D1 migrations through `0005_vault_key_epochs.sql` are applied. The live
health endpoint advertises scoped protocol `1.1` and legacy migration protocol
`1.0`.

## Remote inventory

The required client contract in ADR-0027 is **not deployed** on the Worker version
listed above. A CLI built from that change deliberately refuses protected calls
to the old service. Do not distribute it as live-compatible or add headers to an
old CLI to suppress this refusal.

For the private cutover: stop synchronization services/clients, retain local state
and recovery material, qualify the exact matched Worker/CLI artifacts, deploy the
Worker, verify public health advertises contract 1 and all required capabilities,
and verify old-client refusal with authorized disposable credentials before
resuming upgraded clients. Then execute packaged independent-peer/cloud UAT.
Browser login/device approval remain available without client contract headers.
Bootstrap compatibility refusal precedes redemption; an ambiguous network failure
is not proof that a grant was not consumed. Never automatically reissue a grant
on that assumption.

Do not use mixed old/new Worker traffic or rollback to the old ungated artifact.
Rollback must retain the contract gate; otherwise keep synchronization stopped
and repair forward. A successful cached health check does not protect a daemon
from an unsupported Worker downgrade. The local profile/old-binary migration gate
is still open and must be closed before claiming safe unattended fleet upgrades.

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

### Local profile upgrade

Fresh profiles use the framed local format. Existing plain JSON profiles require:

```bash
statecase --json profile status
statecase --json profile upgrade --dry-run
statecase daemon stop
# Stop other Statecase supervisors, restores and profile users as well.
statecase --json profile upgrade --yes
```

Only run the confirmed step after operator approval and stopped processes.
Keep the returned `backupPath`. The migration never reads credentials or moves
native files and does not update the remote Worker. `config.json` now contains a
format header plus a JSON envelope: do not use raw JSON editing, strip the header,
or replace it with the backup to bypass an incompatible binary. Existing bespoke
scripts that parse this file must migrate to supported CLI operations.

After exit 7 or an interrupted upgrade, inspect `profile status` first. A current
format is a no-op on retry; an old format still requires migration. Completed
backups are retained even when a later source change aborts the upgrade. Unknown
or malformed formats fail closed. This is not a blanket fence for arbitrary old
commands that never open the profile, or permission to leave old writers running.

### Local credential protection

Existing profiles keep their owner-only file mode unless explicitly migrated:

```bash
statecase --json credentials status
statecase --json credentials protect --dry-run
statecase --json credentials protect --yes
```

Linux native protection requires `/usr/bin/secret-tool`, a persistent Secret
Service and an accessible/unlocked login collection. Status and preview do not
probe that service and are not proof that it is available. File-mode profiles
remain usable on headless/ephemeral installations without a keyring.

macOS uses `/usr/bin/security` and the OS default keychain/search list. Set
`STATECASE_KEYCHAIN_PATH` to an existing absolute keychain path to select it
explicitly; use the same selection for every CLI/daemon process on that
profile. Changing it does not migrate a key. Statecase does not create or
unlock your keychain, change the default search list, or grant all applications
access to its item. Locked/unavailable storage fails closed. The explicit
temporary-keychain flow passed native CI; default-keychain UI, reboot and
interactive unlock are not qualified by that drill.
`daemon install` pins the explicitly selected macOS keychain path in the
launchd definition; it does not copy your shell's other environment values.
Stop the daemon before reinstalling with a changed selection, then start it
again. Stop/uninstall still work without repeating the selected path. This
setting is local to the installation and never synchronizes to other devices.

Once protected, all credential reads/writes use the native wrapping key;
`logout` removes the service token but keeps vault keys and the file encrypted.
Keep the local `credentials.json` and native wrapping key together: copying
that file to another machine is not device enrollment or a recovery kit.
Use normal login/join/bootstrap to enroll a new machine. Never put the local
profile/keyring in a Drop. Status reports protection format, not authenticity
or availability of the key.

Unsafe file permissions/types exit `6`; inspect ownership and permissions
before repairing anything. Concurrent mutation exits `5`; let the current
writer finish and reload before retrying. Native unavailability or ambiguous
commit failure exits `7`; restore native access and inspect/reload the file.
Never delete the native key or replace a protected file with plaintext to
silence an error. Failures before replacement preserve original credential
bytes; a failure after rename can leave a valid new encrypted file. The native
key is retained in either case. Recovery/downgrade and orphan-key cleanup are
not yet supported operator workflows.

The opt-in `STATECASE_PACKAGE_NATIVE_CREDENTIALS=1 npm run test:package` drill
uses a freshly installed tarball, its own D-Bus instance with service activation
disabled, temporary HOME/XDG/profile roots and a disposable GNOME login keyring.
It never accesses the operator's keychain or harness data. Linux dependencies
are `dbus`, `libsecret-tools` and `gnome-keyring`; CI runs this in a dedicated job.
On a disposable macOS runner the same opt-in flag selects
`scripts/uat/native-macos-credentials.mjs`: it creates a password-protected
temporary keychain, explicitly addresses it on every native operation, tests
locked/missing-store refusal and encrypted updates, and deletes that exact
keychain and fixture. It never lists or selects the operator's default store.
Creation temporarily adds the owned keychain to the OS search list; exact
deletion removes its entry. Run this only on a disposable macOS runner.
Neither drill qualifies OS reboot, cloud sync or interactive unlock UI.

### Native service runtime

When upgrading to the ADR-0022 lock format, stop older Statecase daemons and
supervisors before starting the replacement CLI. Do not run older and newer
lock implementations against the same local profile. New owner records use
version two; active legacy version-one PIDs are still respected.

Files ending in `.statecase-lock.sqlite` remain after the owner exits: they are
persistent kernel-lock inodes, not stale liveness markers. Do not delete,
replace, inspect with ordinary file reads from an embedded Statecase process,
or synchronize them; sidecars and case variants are also excluded. Use
`statecase daemon status` to inspect liveness. A crashed new process releases
its native lock automatically; a malformed owner record still fails closed
and should be investigated with all writers stopped. This mechanism requires
a local filesystem with working SQLite locking, not NFS/shared agent homes.

`statecase daemon install` pins the current Node executable. Reinstall the
definition and stop/start the service after replacing/removing that Node installation; the service manager
does not load nvm or your interactive shell startup files. Linux definitions
retain their filesystem hardening and require configured writable roots to be
available. `statecase daemon status` uses owner-only local IPC.

The [Linux lifecycle drill](uat/2026-09-08-native-systemd.md) passed with isolated
fixtures. The [macOS lifecycle drill](uat/2026-09-08-native-launchd.md) passed
on macOS 26.6.2 arm64 / Node 24.20.0. The combined native Linux/live Cloudflare
background drill also passed with two isolated installations on one host.
Separate-host/native-harness convergence and sleep/boot behavior remain gates.
Use `statecase daemon start|stop|status` after installation.
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

`npm run uat:native-codex` separately qualifies native Codex 0.153.4 resume
against the actual sync engine and an in-memory reference transport. Set
`STATECASE_UAT_CODEX` to its absolute executable and `STATECASE_UAT_PARENT` to
an absolute disposable-fixture parent outside `/tmp`. The driver generates new
homes, isolated SQLite/config roots, an unborn Git workspace, and a loopback
Responses provider. It uses no model-provider credentials. All generated
session contents remain in its private fixture and are removed after execution.

The default native permission mode is `workspace-write`. Only in a dedicated
disposable VM/container, use `STATECASE_UAT_CODEX_SANDBOX=externally-isolated`
together with `STATECASE_UAT_CONFIRM=run-native-harness-in-disposable-sandbox`
when nested sandboxing is unavailable. This changes the generated fixture's
configuration, never the operator's harness. The CI job runs this opt-in in a
fresh hosted runner VM. See the [executed scope and limitations](uat/2026-09-08-native-codex-resume.md).

`npm run uat:native-claude` runs the corresponding Claude Code 2.1.263
Read/Edit/Write, original-UUID resume, and return-sync drill. Run it only in a
disposable sandbox/runner with an absolute `STATECASE_UAT_CLAUDE` executable,
absolute `STATECASE_UAT_PARENT`, and
`STATECASE_UAT_CONFIRM=run-native-harness-in-disposable-sandbox`. It creates
fresh homes and native project paths, whitelists the child environment, allows
only file tools in restricted mode, and uses synthetic loopback provider
credentials. Never supply an existing agent profile. No hosted model account
or live Cloudflare service is involved. See the
[Claude execution report](uat/2026-09-08-native-claude-resume.md).

The [packaged cross-peer Claude drill](uat/2026-09-08-cloud-native-claude.md)
separately passed foreground shim publication/resume/return against live
Cloudflare across two independently provisioned Daytona instances. Its peer
driver requires explicit remote-write confirmation, private synthetic enrollment
inputs, and external exact-target cleanup. It is not part of credential-free
CI. Follow the report's package hashes, phases, and limits; do not substitute
production agent profiles or assume the later skill-root fix was in that tarball.

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

If local sync reports incomplete materialization rollback, stop the affected
daemon and harness before retrying or cleaning anything. A newer editor write
may have been deliberately preserved instead of being replaced by older data.
Available original versions remain next to the affected files as
`<filename>.statecase-transaction-<uuid>.staged/backup`, inside a private `0700`
directory; earlier versions used the sibling
`<filename>.statecase-transaction-<uuid>.backup`. Both contain local plaintext
and retain the original file's permissions. The `prepared` child, when present,
contains uninstalled incoming data. Preserve both versions, inspect
the exact affected paths, and copy recovery material to a private location
outside synchronized roots before deciding which version to keep. Never run a
wildcard cleanup over these backups. Statecase excludes transaction artifacts
from ordinary sync, but Git and other tools may still enumerate them.

These individual backup files are not emergency snapshot manifests: do not
pass them to `emergency rollback`. Automated recovery after process/power loss
and an operator-facing transaction recovery command remain release gates.

ADR-0030 implements an internal file replay primitive tested with separate killed
and recovering processes. It is not yet enabled in normal CLI/daemon/shim sync and
does not add a user-facing recovery command. Do not treat it as an available
remedy for a real partially applied Git/profile transaction; preserve the affected
state under the procedure above until the complete recovery workflow is qualified.

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
