# Native macOS service lifecycle — 2026-09-08

Status: passed; isolated launchd GUI-domain lifecycle only
Test IDs: RT-007, RT-012, RT-013, RT-014; notification component of RT-010

## Candidate and authoritative evidence

- Commit: `640dbdf5908a7a6041f815133c252550687595ee`.
- [CI run 34175198816](https://github.com/alemicali/statecase/actions/runs/34175198816):
  success, including quality, Node 22/24 compatibility, and native-macos.
- [Native job 101903106684](https://github.com/alemicali/statecase/actions/runs/34175198816/job/101903106684):
  success; actual launchd operations, not a mocked manager.
- Hosted runner image `macos-26-arm64`, image version `20260831.0337.3`.
- OS reported by runner: macOS 26.6.2, build 25G83; Node v24.20.0 arm64.
- CLI built from the checkout after clean `npm ci`.
- Driver: `scripts/uat/native-launchd.mjs`.

The final job log emitted `result: pass`, `nativeManager: launchd-gui`, and
`cleanupVerified: true`, then exited zero. Only synthetic unauthenticated
HOME/profile/Drop state was used. The job received no cloud account, vault,
harness credential, model-provider token, or production deployment secret.

## Acceptance checks

- Refuse an already registered Statecase launchd job before creating fixtures.
- Install the real CLI-generated plist outside the runner's normal HOME.
- Start through `statecase daemon start`, with an explicitly pinned Node path.
- Verify the manager's registered path resolves to the installed fixture plist.
- Verify one watched root, visible queued work, Unix socket mode 0600, and
  profile mode 0700.
- Repeat start without changing the daemon PID.
- Refuse stop from another STATECASE_HOME and refuse a duplicate foreground
  daemon without changing the original PID.
- Observe the exact `filesystem` trigger after a synthetic Drop write.
- Deliver SIGKILL through launchctl; observe launchd restart with a new PID.
- Stop through the CLI; verify unloading, IPC disappearance, and lock removal.
- Repeat stop without failure; start again and observe a new process.
- Uninstall through the CLI and verify the launchd target is absent.

Local tests additionally cover foreign installed profiles, unknown files,
manager-loaded path mismatches, explicit missing-service versus other errors,
ambiguous launchd output, redacted manager failure, and ordering that enables a
job before bootstrap. The local check passed 446 tests, 90.29% overall branch
coverage, and 100% service-module branch coverage; the same candidate's full CI
was green.

## Boundaries

This qualifies the listed lifecycle on the recorded OS/runtime combination.
It does not qualify encrypted background convergence, real harness resume,
sleep/wake/network transitions, login/reboot persistence, Intel macOS, older
macOS releases, or an npm-registry-distributed release artifact. Those claims
need their own evidence. `macos-latest` runs the drill on every PR so changes to
launchd's diagnostic format fail visibly; unknown formats fail closed rather
than authorizing control of an unidentified service.

Fixture cleanup removes the plist and unloads/disables the job. The disposable
hosted runner owns the remaining synthetic files and is discarded after the
job. No user workstation was provisioned or altered by this macOS drill.
