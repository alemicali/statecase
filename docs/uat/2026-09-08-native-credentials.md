# Explicit Linux credential protection: local and packaged native qualification

Date: 2026-09-08
Status: recorded Linux scope passed; not complete production qualification
Test IDs: AU-012, AU-013, CR-011

## Candidate and evidence

The candidate adds ADR-0021 credential protection above `e908cd0` on
`feat/statecase-sync-core`. No cloud deployment or migration was needed.

- Node `22.22.3`, Linux; GNOME Keyring `46.1`, D-Bus `1.14.10`.
- New credential implementation SHA-256:
  `3d4e18b656fcc444f65bf60d3a36d12e0362d411641c1d469ea2c22494463e40`.
- Final native driver SHA-256:
  `4eea90bf27fae609aa7c745b793a54b229542e3fc27069a98a4922a3837b6d7e`.
- Final clean-install `@statecase/cli@0.1.0` tarball SHA-256:
  `d21d83e03ee7b8afb0a7f58875de20c8b6c147d9759e5d6cec1c1a21a866de83`.
- Full `STATECASE_PACKAGE_NATIVE_CREDENTIALS=1 npm run check` passed lint,
  typecheck, **540 tests in 38 files**, coverage, build and native package smoke.
  Global branches: **90.42% (3287/3635)**. New credential module: **91.34%**.
  The earlier complete-check package hash was
  `8b22361fea0c62df776de2fb029f154e35223587739731615fa44c00f686a477`;
  after the package README update, the final clean-install native smoke was
  rerun successfully and produced the final tarball hash above. Product source
  and native driver were unchanged between those two successful runs.
- Workspace branches remain **88.88%**; this report does not waive that
  existing critical-code coverage gap.

The recorded native runs are local, not Daytona or a second physical machine.
A dedicated CI job now repeats the clean-package/private-keyring test on a
disposable Ubuntu runner with Node 24. Its result must be checked separately;
adding the job is not evidence that it passed.

## Isolation and executed acceptance sequence

The driver imports only Node built-ins and invokes the installed CLI. No
product-source imports substitute for the packaging boundary.

1. Allocate a fresh `0700` temporary root and explicit HOME, XDG config/data/run,
   Statecase and unused harness roots. Inherit no operator session-bus address,
   provider credentials, keyring control variables or normal harness profile.
2. Launch a private D-Bus session with its socket inside that root, no service
   activation directories and no activation helper. Only the explicitly spawned
   foreground GNOME secrets daemon can provide the fixture's Secret Service.
3. Seed a synthetic `0600` version-one credential file and offline-only config.
   Preview leaves file bytes and native data directory unchanged. Confirmed
   protection without a service exits `7`, preserving the exact original file.
4. Start the private daemon with a fresh, nonempty random login-keyring password
   supplied through stdin. Confirmed protection stores the wrapping key and
   replaces credentials with a version-two owner-only envelope. Synthetic
   token/key/password canaries are absent from the file and CLI diagnostics.
5. In a separate CLI process, selecting the fixture vault succeeds, proving the
   protected vault key is available. Repeating protection is idempotent.
6. Lock only the private fixture's login collection using the standard
   [Secret Service Lock method](https://specifications.freedesktop.org/secret-service/latest/org.freedesktop.Secret.Service.html).
   Read its `Locked` property and verify `true`. `logout` exits `7`; encrypted
   credential bytes remain identical. No interactive unlock UI is used.
7. Stop the owned keyring daemon. Status still reports the document format
   without requiring key access. `logout` again exits `7`, preserving bytes.
8. Start a new daemon with the same isolated HOME/data and fixture password.
   Selecting the vault succeeds, qualifying persisted key retrieval across a
   keyring-process restart. Successful logout writes another version-two
   envelope, and selecting the retained vault still succeeds.
9. Verify a persistent `login.keyring` exists under the synthetic data root.
   Stop the owned daemon, terminate the private bus/process group, remove the
   generated root and verify its absence before reporting `fixtureCleanup`.

All phases above passed against the final clean-installed tarball. The driver
also passed against the directly built CLI before package qualification.
Private D-Bus isolation follows the documented
[dbus-run-session regression-test use](https://dbus.freedesktop.org/doc/dbus-run-session.1.html).

## Failing-first regressions and integration findings

- A FIFO could block on open before type validation: fixed with nonblocking
  open, while still refusing nonregular files.
- Protected updates fetched a second key after authenticating the old file:
  a changing backend could make the new file unreadable. One retrieved key now
  authenticates the old payload and encrypts its replacement.
- Extra protected-document metadata was accepted: strict metadata validation
  now rejects documents carrying unexpected plaintext fields.
- A malformed replaced lock could override the stable primary error with raw
  lock-reader diagnostics: preserve the redacted error and foreign lock.

All four targeted tests failed before their fixes and pass afterward. Additional
tests cover malformed/oversized payloads, UTF-8, circular input, unsafe modes,
hard links/symlinks/directories, missing/wrong key/context, corruption, stale
read/save, foreign locks, failed migration, and complete historical/scoped key
preservation. CLI tests cover explicit confirmation, non-mutating preview,
idempotency, encrypted logout, safe output and stable exit codes.

Two initial test failures were fixture defects, not product fixes: the native
helper spy used a shared Buffer view that was correctly zeroized by the product;
one older supervised-session fixture wrote credentials with permissive default
permissions. The spy now owns a copy and that fixture explicitly uses `0600`.

## Cleanup and remaining scope

Generated keyrings, credentials, passwords, temporary profiles, package archive
and clean-prefix installation were removed; they are not recoverable. The
driver verifies fixture-root removal and owns the exact process handles/groups
it terminates. No operator keychain/harness/profile or cloud resource was read
or modified by this qualification.

This does not qualify macOS Keychain, native Windows, machine reboot/suspend,
interactive unlock prompts, cloud synchronization with protected profiles,
native-store loss recovery, explicit downgrade, orphan-key cleanup, or an
independent security review. Simultaneous stale-lock reclamation after crashes
also remains unqualified; the tests cover active-writer exclusion, not that
shared runtime-lock recovery race. Cooperative filesystem locks/CAS are not protection
against arbitrary same-principal filesystem replacement or whole-file rollback.
Existing file-mode/headless profiles remain explicitly supported; a green
native test does not silently migrate them or change the product's full scope.

Reproduce on Linux with `dbus`, `libsecret-tools`, `gnome-keyring` installed:

```sh
STATECASE_PACKAGE_NATIVE_CREDENTIALS=1 npm run check
```
