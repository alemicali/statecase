# macOS credential protection qualification

Date: 2026-09-08
Test IDs: AU-012, AU-013, CR-011
Status: implementation and local regression checks passed; native macOS CI pending

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

Until CI executes this scope, local mocked helpers are not native macOS
qualification. Default-keychain UI, login-session behavior, reboot/sleep,
credential recovery/downgrade, orphan-key cleanup and independent security
review remain separate gates. This is not a cloud/harness continuity test.
