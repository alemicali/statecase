# Statecase

> Take your agents anywhere. The encrypted Dropbox for agents: carry sessions,
> skills, context, and work in progress across every machine, so each agent
> picks up exactly where it left off.

Statecase is a new local-first, end-to-end encrypted portability layer for
agent harnesses. Codex and Claude are the first adapters; the architecture is
designed for agents generally.

## Status

The foreground portability path is implemented and the Cloudflare service is
live at `https://statecase-api.hi-0e6.workers.dev`: Better Auth device
authorization, D1 identity/catalogue, R2 encrypted objects, Durable Object
commits, local XChaCha20-Poly1305 encryption, passphrase-protected recovery
kits, Codex/Claude session and skill adapters, exact Git index/worktree overlays, arbitrary
Drops, logical workspace remapping, deletion tombstones, transactional local
materialization, a crash-safe runtime journal, transparent harness shims, and
the canonical agent skill. Immutable Session Capsules bind native sessions to
their exact harness, Git baseline, workspace overlay, and Drop revision;
unavailable/external context is reported instead of silently copied.
Clean Git LFS pointers are never mistaken for content. With `--git-fetch auto`,
Statecase first uses the device-local LFS cache, then runs bounded,
non-interactive `git lfs fetch` against the existing `origin` when required,
checks out the object, and verifies its declared size and SHA-256. Failures are
redacted and roll back partial materialization; an encrypted overlay that
already replaces or deletes the path remains portable.
`statecase run codex|claude` performs a bounded
preflight pull, supervises the unmodified harness, publishes periodically, and
attempts a final flush without preventing offline use or changing the child
exit status. Protocol 1.1 gives ephemeral machines a one-time bootstrap into
explicit encrypted namespaces: no vault root key is transferred, scoped
clients cannot use legacy vault-wide routes, and read+append work is published
as an immutable delta that persistent devices can reconcile.
Full-key devices deterministically merge concurrent complete-record appends to
the same recognized Codex or Claude JSONL session when both retain the exact
accepted prefix. The merge preserves both branch orders and dependency
activity; rewrites, invalid tails, and incompatible order remain conflicts.

The persistent daemon can run with `statecase daemon foreground` or be installed
as a systemd user service / macOS LaunchAgent. Session push and pull now stream
through bounded secure staging, use record-aware 4 MiB chunks, and transfer only
changed tail chunks. Concurrent append merge also streams and verifies the
common history while retaining only bounded branch suffixes, and the accepting
pull verifies record order as a stream. Staging preflights temporary-disk space
and retains a safety reserve before copying plaintext. A real Daytona run has
qualified 2-GiB transfer and concurrent append merge. Daily reachability GC now
applies 24 hourly, 30 daily, and 12 monthly UTC checkpoints plus protected
snapshots, Session Capsule pins, and a 30-day grace period. Remaining release
gates include macOS service UAT, authenticated background convergence,
sleep/reboot qualification, initialized-submodule hydration, live
real-version harness restore UAT, process-reset rotation fault injection,
and real-version Codex/Claude fixture certification. Local and workerd coverage
already exercises fresh vault-key epochs, exact active-device sealed envelopes,
old-epoch write denial, capability invalidation, and multi-epoch recovery.
The packaged post-revocation rotation, multi-epoch offline catch-up, clean-device
recovery, scoped reissuance, and historical Drop restore passed a live Daytona
drill against Cloudflare.
This is not yet a public-production release.

The [native Linux lifecycle drill](docs/uat/2026-09-08-native-systemd.md) passed
start/stop, private IPC, filesystem notifications, duplicate-writer denial,
and SIGKILL recovery with the hardened systemd-user definition.

The approved direction lives in:

- [Product strategy](docs/PRODUCT_STRATEGY.md)
- [Implementation specification](docs/IMPLEMENTATION_SPEC.md)
- [Test and UAT plan](docs/TEST_AND_UAT_PLAN.md)
- [Two-GiB Daytona UAT](docs/uat/2026-09-07-two-gib-session-daytona.md)
- [Key rotation and recovery Daytona UAT](docs/uat/2026-09-08-key-rotation-daytona.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Readiness review](docs/READINESS_REVIEW.md)
- [Operations](docs/OPERATIONS.md)
- [Daytona and Cloudflare product UAT](docs/uat/2026-09-06-daytona-cloud.md)
- [Daytona Git-baseline acquisition UAT](docs/uat/2026-09-07-git-baseline-daytona.md)
- [Daytona and Cloudflare in-place restore UAT](docs/uat/2026-09-07-in-place-restore-daytona.md)
- [Daytona and Cloudflare Git workspace restore UAT](docs/uat/2026-09-07-workspace-in-place-restore-daytona.md)

## Repository shape

```text
apps/       deployable CLI, daemon, Worker, and later dashboard
packages/   domain, protocol, crypto, storage, adapters, workspace, and Drops
skills/     agent-native Statecase skills
docs/       product, implementation, security, tests, policy, and ADRs
```

Statecase is a standalone greenfield product. It does not depend on AgentStash,
ClawStash, or Restic.

## Development

```bash
npm ci
npm run check
npm run cloud:test
docker compose -f compose.test.yaml run --rm --build test
```

Build and run the CLI without installing anything globally:

```bash
npm run build
./apps/cli/dist/bin.js --json status
```

Node.js 22.12+ and system Git are required. Git provides workspace identity and
working-tree overlays; Statecase never synchronizes Git credentials.

Build an installable tarball and smoke-test it in a clean prefix:

```bash
npm run pack:cli
npm install --global ./statecase-cli-0.1.0.tgz
statecase --json status
```

The package contains the compiled CLI and canonical Statecase skill; it does
not depend on the private workspace packages at runtime. Tagged releases
attach the same tested tarball and checksum to GitHub Releases.

## First setup

```bash
./apps/cli/dist/bin.js login
read -rsp 'Recovery passphrase: ' STATECASE_RECOVERY_PASSPHRASE && export STATECASE_RECOVERY_PASSPHRASE
printf '\n'
./apps/cli/dist/bin.js vault create personal --recovery-file "$PWD/personal.statecase-recovery.json"
unset STATECASE_RECOVERY_PASSPHRASE
./apps/cli/dist/bin.js workspace attach --auto --path /path/to/checkout --mode git-overlay --git-fetch ask
./apps/cli/dist/bin.js setup --harness codex,claude --transparent
# Prepend the path printed by setup to PATH, then verify both shims:
./apps/cli/dist/bin.js shim verify codex
./apps/cli/dist/bin.js shim verify claude
./apps/cli/dist/bin.js push --dry-run
./apps/cli/dist/bin.js push
# Optional owner inspection; scheduled retention already runs daily.
./apps/cli/dist/bin.js --json retention plan
```

On a second machine, login, join the vault with the encrypted recovery kit,
attach the same logical Git workspace at its new local path, map any Drops by
their non-secret IDs, then run `pull`. `setup` installs the Statecase skill into
both the Codex-compatible `.agents/skills` root and Claude's skills root.
If a checkout moves later, use `workspace move <id> <new-path>`; use
`workspace detach <id>` to stop mapping it on that device. Both commands leave
the checkout and cloud namespace untouched. A changed path invalidates the
local applied marker so the next pull must verify and hydrate the destination.
Drops have the corresponding device-local lifecycle commands: `drop status
[id]` reports root availability and applied-versus-remote revision alignment,
while `drop remove <id>` forgets only the local mapping. It never deletes the
directory or its encrypted remote namespace. Status is deliberately fast: an
`applied` result does not claim that unscanned local files are unchanged.
Use the generated shims, the installed daemon, or invoke `statecase run codex
-- <args>` / `statecase run claude -- <args>` explicitly.
`statecase bypass codex -- <args>` starts the recorded real executable without
synchronization.

Workspace baseline acquisition is a device-local policy. `--git-fetch ask`
(the default) exits with code `5` and `BASELINE_UNAVAILABLE` before network or
workspace mutation when the exact commit is absent or different; fetch the
commit yourself or explicitly reattach with `--git-fetch auto`. `auto` invokes
system Git against that checkout's existing `origin`, with interactive Git
prompts disabled, and then checks out the exact commit before applying the
encrypted overlay. `never` always requires manual provisioning. Statecase does
not store, transfer, or print the remote URL or Git credentials.

The same policy governs missing Git LFS objects. `auto` requires the system
`git-lfs` binary, attempts the local LFS object cache before any network call,
then fetches only through the checkout's existing `origin`. Statecase clears
per-repository LFS include/exclude filters for the exact baseline fetch, verifies
materialized size and SHA-256, and restores original pointers/missing files if
the operation or a later workspace transaction fails. `ask` and `never` perform
no LFS mutation or network access.

For a persistent process under an existing supervisor:

```bash
./apps/cli/dist/bin.js daemon foreground
./apps/cli/dist/bin.js daemon status
./apps/cli/dist/bin.js daemon install
```

The daemon owns one profile lock, watches mapped roots, polls the remote head,
reconciles on a maximum deadline, retries with jitter, and exposes status only
through an owner-only Unix socket. Service definitions are Statecase-owned,
atomically written, hardened on systemd, and safely removable with
`daemon uninstall --yes`; release claims still require Linux and macOS UAT.

Use `device list` to inspect stable installation identities and `device revoke
<id> --yes` to block a lost installation and all of its bound service sessions.
Revocation prevents future server access; it cannot erase plaintext already
present on the lost machine. Then rotate every vault the device could access
from a remaining owner device, writing a new recovery artifact to a path that
does not already exist:

```bash
read -rsp 'New recovery passphrase: ' STATECASE_RECOVERY_PASSPHRASE && export STATECASE_RECOVERY_PASSPHRASE
printf '\n'
statecase --json vault key rotate --recovery-file /secure/new.statecase-recovery.json --yes
statecase --json sync
unset STATECASE_RECOVERY_PASSPHRASE
```

Rotation creates a new root key, excludes revoked members, invalidates existing
scoped capabilities, and makes the next write for each configured namespace a
new-epoch snapshot. Keep the new recovery kit and retire the old kit only after
an active peer has synchronized and a replacement-device recovery drill has
succeeded. Existing installations without an exchange key must run
`statecase login` again before rotation. If the mutation outcome cannot be
confirmed after a connection failure, Statecase leaves local credentials at
the old epoch and preserves the candidate kit at the reported path; run
`statecase sync` before attempting another rotation.

Protect the current remote head with `snapshot create <name>`, inspect it with
`snapshot list`, and recover one configured namespace without touching the
live head using `restore --revision <id> --mapping <id> --target <staging-dir>`.
Statecase refuses a non-empty staging target unless `--yes` is explicit, and
normal conflict checks still apply after confirmation.

On a full-key device, a two-way Drop, stopped Codex/Claude mapping, or Git
workspace can instead be restored in place. Preview first, stop the daemon and
any affected harness, then approve the exact replacement:

```bash
statecase --json restore --revision <id> --mapping <id> --in-place --dry-run
statecase --json restore --revision <id> --mapping <id> --in-place --yes
```

Statecase protects the current cloud head, saves an owner-only local emergency
snapshot, applies and validates the historical state, and publishes it as a
new revision; it never rewinds the shared remote head. The JSON result includes
the protected snapshot ID and emergency snapshot path. To recover the
pre-restore local bytes, keep the daemon and harness stopped and run
`statecase --json emergency rollback <snapshot-path> --yes`. For a workspace,
the emergency snapshot also preserves symbolic or detached HEAD, every branch
ref the restore can move, the raw Git index, and all affected worktree paths.
Initialized submodule worktrees fail closed; Statecase never copies or rewrites
their nested repositories.

Offline edits to different files merge automatically against the last revision
each device actually applied. Concurrent complete-record appends to the same
portable session also merge on full-key clients; the publisher must pull the
merged result before resume because its applied marker intentionally stays
behind. Each installation remembers the session's native relative path locally,
so that pull updates the original dated/project file; a new device uses a
canonical adapter path without forcing matching home directories. Other
same-path divergence fails with explicit paths. After inspecting
the remote side through staging restore, an
intentional local winner can be published with `conflicts resolve --mapping
<id> --strategy local --yes`; Statecase first protects the exact remote head.

Before resuming an older session on another machine, inspect and hydrate its
recorded closure rather than pulling whichever workspace happens to be latest:

```bash
./apps/cli/dist/bin.js --json workspace capsule <workspace-id>
./apps/cli/dist/bin.js --json workspace dependencies
./apps/cli/dist/bin.js --json workspace hydrate --session <capsule-id> --mode strict --dry-run
./apps/cli/dist/bin.js --json workspace hydrate --session <capsule-id> --mode strict
```

`workspace capsule` is a local, offline preview of the next Git overlay. It
reports baseline/ref and aggregate record/blob sizes without printing captured
file bytes or changing Statecase configuration. `workspace dependencies`
inspects the distinct immutable Session Capsules already stored remotely.
Capsules may pin the harness, workspace, and individual Drops to different
vault checkpoints; hydration composes those exact namespace revisions and
materializes them atomically instead of substituting current heads.

`warn` reports a partial resume with exit code `8`; `best-effort` is available
only as an explicit acceptance of missing context. Map a reported external
dependency as a Drop and checkpoint it before expecting a strict resume.

For an ephemeral sandbox, create the capability on a trusted full-key device.
The bootstrap secret is written to a new owner-only file and is never included
in normal or JSON output:

```bash
./apps/cli/dist/bin.js token create \
  --namespace workspace:ws_project,harness:codex:default \
  --actions read,append --ttl 120 --output /secure/bootstrap.token
```

Inject that file or `STATECASE_BOOTSTRAP_TOKEN` into a fresh
`STATECASE_HOME`, redeem it once, configure only authorized mappings, and pull:

```bash
./apps/cli/dist/bin.js bootstrap --token-file /run/secrets/statecase-bootstrap --non-interactive
./apps/cli/dist/bin.js workspace attach --id ws_project --path "$PWD" --mode git-overlay --git-fetch auto
./apps/cli/dist/bin.js setup --harness codex
./apps/cli/dist/bin.js pull
```

`statecase run codex -- <args>` then performs preflight/periodic/final sync.
An append-capable sandbox may publish changed and deleted paths as immutable
delta records, but cannot replace a namespace head with an unrestricted write.
Revoke the grant with `token revoke <id> --yes`; remove the bootstrap file from
the secret-delivery system after successful redemption.

Account creation is deliberately allowlisted. Never put
`STATECASE_TOKEN`, `STATECASE_RECOVERY_PASSPHRASE`, or the recovery kit in a
prompt, Git repository, shell history, or process argument.

Production code follows test-first development and the controls in
[Repository policy](docs/REPOSITORY_POLICY.md).

## License

MIT
