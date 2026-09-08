# ADR 0021: Explicit OS-backed local credential protection

Status: implementation and qualification in progress
Date: 2026-09-08
Test IDs: AU-012, AU-013, CR-011

## Context

ADR-0004 calls for an OS credential store. The later implementation specification
also explicitly permits owner-only credential files for the initial release, and
the threat model permits protected files in headless environments. Both modes
must be supported rather than treating keychain availability as a prerequisite
for ephemeral bootstrap or silently changing existing profiles.

## Decision

Keep existing version-one protected-file profiles compatible. Add an explicit
`credentials protect --dry-run` / `credentials protect --yes` migration and a
non-secret `credentials status` inspection command. Preview must not consult or
mutate a native keychain. No existing profile is silently migrated.

Store a fresh, random 32-byte local wrapping key in the native credential store;
keep token, device exchange key, vault keyring and scoped keys together in a
version-two encrypted `credentials.json`. Use the existing XChaCha20-Poly1305
envelope with a dedicated local context and random opaque key reference. A
single small native item avoids backend-specific limits on large credential
payloads. A protected file never falls back to legacy plaintext when a key is
missing, locked, invalid, inaccessible, or fails authentication.

Migration authenticates/read-backs the stored wrapping key and encrypted payload
before atomically replacing the old file. Existing credential bytes remain
authoritative until replacement. Cooperating updates serialize through an owned
credential lock and reject stale read-modify-write snapshots. A failed or
ambiguous migration retains any newly created native key; automatically deleting
it could render a committed encrypted file unreadable. Orphan-key cleanup and
explicit protection downgrade require separate verified procedures.

Backend selection is encoded in the protected document, not inferred from each
machine's current environment. Linux uses the persistent Secret Service through
the system `secret-tool`, without fallback to an ephemeral kernel keyring.
The wrapping key travels through stdin/stdout pipes, never argv or diagnostics.
Helper execution has an environment allowlist, bounded output and timeout.
The file reader rejects extra protected-document metadata and opens with
`O_NOFOLLOW | O_NONBLOCK`, so a FIFO cannot block before file-type validation.
Updates authenticate the old document and encrypt the new payload using one
retrieved key, not two independent backend reads that could disagree.
Unsupported platforms fail closed. macOS now has an adapter; its native
qualification is tracked independently from the Linux implementation.

macOS uses `/usr/bin/security`. An add sends exactly one quoted interactive
command through stdin followed by EOF, not secret-bearing process arguments.
It never enables verbose logging, overwrite (`-U`), or unrestricted access
(`-A`). The default OS keychain/search list applies unless the local
`STATECASE_KEYCHAIN_PATH` explicitly selects an absolute path. This selection
is not synchronized or persisted inside the protected document; keep it stable
for every process using that profile. Invalid/control-containing paths and
commands exceeding the native line buffer fail before spawning a helper.

The [Apple command parser](https://raw.githubusercontent.com/apple-oss-distributions/Security/main/SecurityTool/macOS/security.c)
supports quoted tokens and preserves the final command's exit status at EOF.
The [password reader](https://raw.githubusercontent.com/apple-oss-distributions/Security/main/SecurityTool/macOS/keychain_find.c)
adds one newline to printable output; only macOS strips that one delimiter.
Critically, Apple's
[keychain list builder](https://raw.githubusercontent.com/apple-oss-distributions/Security/main/SecurityTool/macOS/keychain_utilities.c)
can return a null reference after a failed single-path open. A null search
scope means the default list. Statecase repeats an explicitly selected path in
read arguments to force an array, even when empty, preventing that fallback.
Adds do not use update mode and already reject a failed explicit keychain open.

Protected metadata accepts only `secret-service` and `macos-keychain`. A
different selected protector is rejected before native access, including
preview. Backend identity is authenticated through distinct envelope contexts;
the original Linux context remains unchanged for existing v2 files. Copying a
local credential file across operating systems is not an enrollment mechanism.

The [GNOME secret-tool implementation](https://raw.githubusercontent.com/GNOME/libsecret/master/tool/secret-tool.c)
supports pipe input for store and pipe output for lookup. Lookup failure does
not distinguish absence from every backend error; both are terminal for an
already protected profile. We do not use its broad search or clear operations.
The evaluated [keyring-node Linux builder](https://raw.githubusercontent.com/Brooooooklyn/keyring-node/main/src/linux_credential_builder.rs)
falls back to kernel keyutils when Secret Service cannot initialize. That
implicit fallback is unsuitable for a durable wrapping-key authority.

## Boundaries and qualification

This protects secrets at rest from reading the credential file alone. It does
not protect against arbitrary code running as the same unlocked OS principal,
OS compromise, plaintext already copied, or historical rollback of a whole
local credential document. JavaScript strings cannot be reliably zeroized;
owned binary key/plaintext buffers are wiped where possible.

Native tests must use a disposable Secret Service session or isolated native
keychain, never the operator's keychain. Required tests include preview,
round-trip/update, missing/locked/ambiguous backend, timeout, wrong key/context,
malformed and oversized files, symlink refusal, foreign locks, failed commit,
source changes during migration, stale saves, and unchanged legacy bytes on
failure. ADR-0022 replaces the racy stale-lock reclamation with a native SQLite
mutex. Deterministic overlap and real-process SIGKILL/restart tests now cover
that boundary; platform/package qualification must track the exact candidate.
Real reboot/unlock, macOS, recovery/downgrade and independent security
review remain release gates until supported by evidence.

The [isolated Linux native/package qualification](../uat/2026-09-08-native-credentials.md)
records real migration, locked/unavailable-store preservation, daemon restart,
and encrypted logout. The drill uses a private
[D-Bus session](https://dbus.freedesktop.org/doc/dbus-run-session.1.html), no
service activation directories, and a fresh password-protected login keyring.
The fixture alone is locked through the standard
[Secret Service Lock method](https://specifications.freedesktop.org/secret-service/latest/org.freedesktop.Secret.Service.html).
That evidence does not qualify interactive unlock UI, an OS reboot or macOS.
