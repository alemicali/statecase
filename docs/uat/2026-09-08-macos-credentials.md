# macOS credential protection qualification

Date: 2026-09-08
Test IDs: AU-012, AU-013, CR-011
Status: explicit native macOS/package flow and launchd keychain selection passed

## Failing-first evidence

The existing implementation failed seven new assertions across the native helper
and credential-file suites: darwin was unsupported and injected macOS protection
incorrectly persisted a Linux backend. After implementation, an explicit-scope
regression also failed until native lookup forced Apple's array search form.
Invalid environment-path tests use CR/LF and size boundaries; NUL cannot be
represented through the real Node process environment (assignment truncates it).

The local `npm run check` passed 572 tests in 41 files, lint/typecheck, build and
clean-package smoke. Global branches: 90.63% (3367/3715); credential module:
93.33%. Overall passing coverage does not waive workspace's separate 88.90%
critical-code gap.

The clean-installed package also passed the isolated Linux Secret Service
regression, including locked/unavailable-store preservation, persistent daemon
restart and encrypted logout, with fixture cleanup verified:

- Node: 22.22.3.
- Package SHA-256: `a4c661c1903aa137c6d3550707797dce26c06ae2333e4c2373a00c50fa702b88`.
- Linux driver SHA-256: `4eea90bf27fae609aa7c745b793a54b229542e3fc27069a98a4922a3837b6d7e`.

## Native macOS scope

`native-macos-credentials` installs a freshly packed CLI in a disposable hosted
macOS runner. The driver uses a fresh profile and password-protected keychain,
with a quoted filename and explicit native arguments for every operation.
It does not list/read/lock/unlock any pre-existing or default keychain.
Creation temporarily adds its owned keychain to the OS search list; deletion
removes that exact entry. Secret values stay out of process arguments and
reported diagnostics. Stages cover preview, absent-store migration, verified
migration, independent-process reopen, idempotency, wrong explicit path,
lock/refusal, explicit fixture unlock, encrypted logout with retained vault key,
deleted-keychain refusal and cleanup.

CI [34189667851](https://github.com/alemicali/statecase/actions/runs/34189667851)
on `ad0dec800c4cb29118f695f771488bf57dfa7cce` passed all nine jobs. The dedicated
native macOS credential job reported every stage above passing and fixture
cleanup verified, with Node 24.20.0:

- Package SHA-256: `0922133a56cd86869b6712ae53af7e37f53ddcdd5f38fb74c9d9b947ce8fb4c7`.
- macOS driver SHA-256: `be8e42aef1cc28f3a570a5f59198f4b834a22eb32295888fdfdefedf7441200b`.

The subsequent launchd-selection follow-up reproduces and fixes loss of
`STATECASE_KEYCHAIN_PATH` between the installing shell and native service. The
installer pins only this local selection in its environment dictionary. Unit
tests preserve legacy ownership/control, XML escaping and reject ambiguous
dictionaries; the lifecycle driver now checks the native manager's effective
environment using an unused synthetic keychain path. A fixed original Linux
envelope context also verifies compatibility independently of the new writer.
The full local check passed 574 tests, 90.66% global branches (3380/3728),
credentials 93.33% and service 100% branches.

Follow-up CI [34189968387](https://github.com/alemicali/statecase/actions/runs/34189968387)
on `e23475cf3b0aa793d64c49765ffbc7523f95cf15` passed all nine jobs, including
native macOS credentials, launchd, background sync, both native harnesses,
Node 22/24 and quality/workerd/audit. The launchd job explicitly reported
`selectedKeychainEnvironment: true`, alongside lifecycle, SIGKILL recovery,
profile isolation and cleanup. The clean macOS package hash is
`cad81a57f9f52196d4768983cd60ce3f4f00bfc80a4f824e84a8babd52097ed2`;
the credential driver hash is unchanged. This is independent evidence for
credential protection and an unauthenticated daemon's environment/lifecycle,
not proof of authenticated native background cloud/harness parity.

Default-keychain UI, login-session behavior, reboot/sleep,
credential recovery/downgrade, orphan-key cleanup and independent security
review remain separate gates. This is not a cloud/harness continuity test.
