# Profile mutex: overlapping recovery and real process crashes

Date: 2026-09-08
Status: local process and native-credential package checks passed; wider qualification pending
Test IDs: RT-016, AU-013, WS-001, WS-004

## Candidate

ADR-0022 changes above `064ad2a`, Node `22.22.3` on Linux. No service deployment
or cloud data mutation was needed for this change.

- Runtime SHA-256:
  `8896dd3d82101712d9bbf180ab699d4d1510ac8641d2e2bbbdd5dc761ad72aa2`.
- Local mutex implementation SHA-256:
  `5f3cda4a4db59aa871eaf4312b414c76eaffa5e706a9c62d89407dd7de99b7f0`.
- Real-process test SHA-256:
  `7709d490be7db1468b47d5ba3692549eb71667f3a8b7133a36b21383b4a3d1ad`.
- Native-credential clean-install tarball SHA-256:
  `237e7d4ff76ad378fbd4df2233ebca7f345d707e617e31fdd344823bdd0ace6a`.

`STATECASE_PACKAGE_NATIVE_CREDENTIALS=1 npm run check` passed lint, typecheck,
**556 tests in 40 files**, coverage, build and clean-install native credential
UAT. Global branches **90.55% (3336/3684)**, runtime **95.45%**, new mutex module
**95.65%**. Workspace remains **88.90%** and is not waived by this result.

## Reproduced failures and fixes

1. The original stale-reclaimer regression allowed two owners: after one
   candidate read the stale PID, another acquired the profile, then the delayed
   candidate removed its replacement. A lifetime SQLite/kernel mutex now
   prevents the second acquisition before either can mutate owner metadata.
2. A linked owner record was read and reclaimed. Bounded, nonblocking,
   no-follow inspection now rejects it while preserving the link target.
3. Version-two PID-reuse recovery initially failed because only version-one
   records were understood. New records now use version two and rely on the
   acquired kernel mutex; live legacy version-one PIDs remain protected.
4. Newly introduced guard filenames were initially transferable as ordinary
   Drop files and accepted in incoming workspace capsules. Failing-first cases
   now exclude/refuse exact names, case variants, sidecars, temporary siblings
   and reserved parent components before content capture/materialization.

## Real-process acceptance

`packages/runtime/test/lock-process.test.ts` bundles the actual runtime and
uses the installed native SQLite binding, with Node-built-in IPC only. Each
test creates fresh temporary paths and processes, with a synthetic HOME and no
operator credentials/harness state.

- An owner acquires the mutex and is terminated with SIGKILL. Eight independent
  child processes then request the same profile: exactly one acquires it and
  seven are denied while that owner remains alive. The guard inode is unchanged.
  After explicit winner release, one previously denied peer acquires it.
- A replacement pauses after stale classification while holding the native
  mutex. Another live process is denied. SIGKILL of the paused process releases
  the kernel lock, and the denied process can retry successfully.
- A replacement pauses after complete private metadata preparation but before
  publication. A competitor is denied until that exact process is killed;
  retry succeeds with complete new owner JSON, not an empty/partial record.

Unit fault cases additionally cover active exclusion, idempotent release,
independent owner replacement, failed publication, permission/type/UID refusal,
native inode publication collision, native filesystem errors and non-secret
diagnostics. Persistent guard files intentionally remain after normal release;
all complete test roots are deleted only after their owned processes end.

## Native credential package regression

The recorded clean-installed tarball passed the existing isolated private-bus
Secret Service drill with the new mutex: explicit migration, read-back,
idempotency, locked/unavailable-store refusal with unchanged credentials,
keyring-process restart, encrypted logout and retained vault access. The driver
verified cleanup of the disposable keyring, native processes and synthetic
credential root. No operator keychain or live cloud service was accessed.

## Background and platform boundaries

The local authenticated background drill also passed against this candidate's
built CLI and local workerd/D1/R2: two independently enrolled daemon processes,
automatic bidirectional transfer, interrupted-upload journal replay, offline
SIGKILL/restart, disjoint convergence, deletion propagation and 45 seconds of
idle no-op behavior. All five reported phases passed; final cleanup returned
`cleanupVerified: true`, `remoteCleanupRequired: false`. Only generated local
profiles, backend data, credentials and owned processes were removed; no
remote resources or operator-native service were changed. This run used the
built CLI, not a separate clean-installed tarball, and one physical host.

Exact-candidate CI, native macOS lifecycle, OS reboot/power-loss, mixed-version
upgrade and complete workspace transaction recovery remain separate gates.
These tests do not qualify arbitrary same-principal inode replacement, a
network-mounted profile, or a fully production-ready Statecase release.

Stop older local Statecase writers before upgrading. Never remove or replace
the persistent guard file to make a process start. See ADR-0022 and operations
for the local lock-format compatibility boundary.

## CI follow-up and native driver regression

CI `34188250327` on `e05a4e9` completed: quality, Node 22/24 compatibility,
background sync, native credential package and native macOS lifecycle passed.
Native Codex and Claude qualification jobs failed immediately at child startup;
the run as a whole failed and is not described as green.

A failing-first external-directory bundle test reproduced
`ERR_MODULE_NOT_FOUND` for `better-sqlite3`. The new runtime dependency made the
bare external import reachable, but each native UAT scenario runs from a
temporary directory outside the repository's module-resolution tree. The
shared test-only builder now resolves the installed native dependency to an
explicit file URL. The regression executes that bundle from an unrelated
temporary CWD and acquires/releases a real mutex. Product packaging and native
scenarios themselves are unchanged; full native Codex/Claude reruns must still
verify the driver correction on its exact commit.
