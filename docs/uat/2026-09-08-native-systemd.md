# Native Linux service lifecycle — 2026-09-08

Status: passed; isolated systemd-user lifecycle only
Test IDs: RT-007, RT-012, RT-013; filesystem notification component of RT-010

## Candidate and environment

- CLI built from `c33acb8` plus the service-runtime pinning changes accompanying
  this report; Node 22.22.3, systemd 255 (255.4-1ubuntu8.17).
- Real host user service manager; no nested/mock systemd.
- Fresh synthetic HOME, STATECASE_HOME, and one Drop outside `/tmp`, because
  the production definition uses PrivateTmp.
- No account, vault, harness credentials, real sessions, or remote objects.
- `scripts/uat/native-systemd.mjs` requires explicit fixture confirmation and
  refuses to run if `statecase.service` already exists.

## Evidence

The driver installs the actual CLI-generated definition with `--no-start`,
links it into the user manager at runtime only, verifies resolved ownership
before service operations, and exercises:

- explicit Node interpreter instead of the manager's different PATH;
- literal spaces, `%`, and `${UNSET}` in executable and watched-root paths;
- service startup with one watched root and visible queued unauthenticated work;
- actual Unix socket type/mode 0600 and profile directory mode 0700;
- refusal of a second foreground daemon without changing the first daemon PID;
- a file write followed by the exact `filesystem` reconciliation trigger;
- manager-delivered SIGKILL, automatic restart, new PID, and stale-lock recovery;
- explicit stop with lock removal and subsequent start with a new PID;
- definition/runtime-link cleanup and final `LoadState=not-found`.

The unchanged hardening includes NoNewPrivileges, PrivateTmp, ProtectSystem
strict, owner-only umask, and explicit writable roots. No security option was
disabled to obtain a passing run. The final driver emitted `result: pass` and
`cleanupVerified: true`, then exited zero. A second read-only manager check
confirmed `LoadState=not-found`, `ActiveState=inactive`.

The earlier attempt stopped before startup because the test compared the
manager's runtime symlink path with the source definition path. It now compares
their real paths. The abandoned link was resolved to the exact synthetic
fixture before removal; no existing user service was replaced.

Local `npm run check` passed: 436 tests in 35 files, 90.14% overall branch
coverage, 97.14% service-module branch coverage, lint, typecheck, build, and
clean-package installation. Four new service tests cover both platforms'
interpreter pinning and control-character rejection; these failed before the
implementation change and pass afterward.

## Reproduction and limits

Build the CLI, create an explicit disposable persistent fixture directory,
and run:

```bash
STATECASE_UAT_CONFIRM=temporary-native-service \
STATECASE_UAT_ROOT=/absolute/disposable/persistent/fixture \
STATECASE_UAT_CLI=/absolute/statecase/apps/cli/dist/bin.js \
node scripts/uat/native-systemd.mjs
```

Run only on a user manager without an existing Statecase unit. The script
does not reboot the machine, change login lingering, or authorize any account.
It qualifies lifecycle, not successful encrypted background transfer. macOS
launchd, authenticated multi-device convergence, sleep/network transitions,
boot/login startup remain follow-up
release work. Fixture contents remain disposable; the driver removes service
definitions and links but does not recursively delete the supplied directory.

## CLI lifecycle follow-up

The subsequent candidate adds `daemon start|stop` and guards every service
operation against another local profile or a different manager-loaded file.
The native driver passed again using those CLI commands instead of direct
systemctl start/stop. It additionally verifies that repeated start preserves
the PID, repeated stop succeeds, and another STATECASE_HOME cannot stop the
running writer. It still uses direct systemctl only for the runtime-only link,
ownership inspection, deliberate crash injection, and fixture cleanup.

Local `npm run check` passed with **446 tests**, **90.29%** overall branch
coverage, and **100%** service-module branch coverage. The launchd command
branches have local contract tests; a new real `native-macos` CI job is the
separate OS-level qualification gate, not implied by this Linux result.
