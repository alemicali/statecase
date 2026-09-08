# ADR 0028: Local profile framing and explicit upgrade

Status: implemented locally; exact-candidate platform qualification pending
Date: 2026-09-08
Test IDs: RT-017, PR-014, SK-001

## Problem and decision

Historical `ConfigStore` readers cast JSON without validating its version.
Adding a JSON `version: 2` therefore does not fence an accidental downgrade.
The new profile remains one atomic document at the established `config.json`
path, but its bytes begin with `STATECASE-PROFILE/2` followed by LF and a JSON
envelope. Despite the historical filename, it is no longer standalone JSON.
Historical JSON readers fail at the fixed public header before interpreting
configuration or using its mappings. Do not strip that header to recover a file.

The envelope declares version 2, minimum client contract 1, required capabilities
from ADR-0027, and a `config` payload. Its in-memory configuration schema remains
version 1. The reader validates known structural fields and preserves unknown
optional payload fields rather than projecting them away. Legacy documents
missing the historically optional workspaces list normalize it to an empty list.
Unsupported framing, required capabilities or malformed data fail with a fixed
redacted error. Parsing/serialization is bounded to 16 MiB per profile document.
This limit is local configuration metadata, not a synchronized-file size limit.

Fresh profiles use format 2 when first saved. Existing legacy files are not
silently rewritten by `loadConfig`, login, sync or setup. Normal reads require an
explicit upgrade. A CLI pre-action guard also protects operations such as logout,
credential changes and global skill installation that previously did not need
to load configuration. Help, `profile status`, `profile upgrade`, and daemon
status/stop retain their necessary discovery/migration paths. `daemon stop`
can read a validated legacy profile to address only its existing owned service.

## Migration workflow and recovery

`statecase --json profile status` reports existence, format and migration need,
without reading credentials, querying native stores, scanning mappings or making
network calls. `profile upgrade --dry-run` validates the input and reports the
transition without creating files/locks/directories. Missing or current profiles
produce a no-op. The caller must choose either `--dry-run` or `--yes`.

Before `profile upgrade --yes`, stop **all** Statecase daemons, supervisors,
restore/configuration commands and other old profile users. The migrator acquires
the daemon barrier, both harness activity barriers and the configuration mutex.
Known active owners fail promptly; all acquired barriers are released on exit.
They supplement, rather than replace, the operator's stopped-process precondition.

After rechecking the observed original, create a unique, owner-only
`config.pre-upgrade-v1.<uuid>.json` containing the exact original UTF-8 bytes.
Fsync the backup and directory before publication. Recheck a bounded file/parent
observation immediately before replacing the configuration. Write and fsync a
private temporary framed document, atomically rename it, then fsync the directory.
Successful output includes `backupPath`. The backup is deliberately retained;
neither credentials nor native context, workspace files or remote data are migrated.

Concurrent source changes produce conflict exit 5 and preserve the newer source
plus any already completed backup. Malformed/unsafe/unsupported inputs and
migration-required profiles use exit 6. Unconfirmed write outcomes use fixed exit
7 without raw filesystem diagnostics. Inspect `profile status` after an ambiguous
failure before retrying. A completed migration is an idempotent no-op on retry.
A stale observed config object cannot overwrite the upgraded profile.

Do not automatically restore an old backup over the live profile or downgrade
the CLI. Keep old documents for inspection/recovery under the compatible release;
any rollback must first stop all users and account for work after the backup.
No general automatic reverse migration is promised. A partial/unconfirmed backup
is not recovery authority; successful migration returns the exact completed path.

## Filesystem and compatibility boundaries

Profile reads use a no-follow/nonblocking descriptor, bounded allocation, regular
single-link/owner/non-group-writable checks, size/identity validation and strict
UTF-8 decoding. Native file types, symlinked profile roots and oversized input
are refused. Temporary cleanup starts only after exclusive creation succeeds,
so a pre-existing staging collision is never removed. Ordinary saves retain
observed-state comparison under the configuration mutex and now fsync publication.

These operations do not establish atomic compare-and-swap against uncooperative
writers or malicious same-user ancestor replacement. Final-check/rename and
already-open-descriptor races, power-loss/platform durability, active historical
writer upgrades and global shared-native-root isolation remain separate gates.
A stopped-profile fence cannot control an arbitrary old command which never
opens the configuration, nor a modified binary or manual header removal. In
particular, old standalone credential/skill commands are not universally fenced
by changing a configuration file. The current CLI guards those entrypoints;
the historical qualification below deliberately does not claim they are blocked.

This format is device-local. It adds no Cloudflare resource, key epoch, encrypted
manifest rewrite or remote protocol generation. It does not make an ungated old
Worker safe, migrate all native history formats, or authorize live deployment.
The matched CLI/Worker cutover in ADR-0027 remains required.

## Alternatives

A version field alone was rejected because historical readers ignored it.
A second configuration file plus a poisoned legacy pointer would create a
two-file migration/rollback problem and two potential sources of truth. Removing
the old path could make old binaries bootstrap a new empty profile. Keeping a
single explicitly framed document gives old readers a deterministic refusal and
one rename boundary. Moving to a different filename can be considered later,
but must preserve refusal at the historical path.

## Verification

Failing-first tests reproduced accepted legacy reads and the absent migration
workflow. Tests cover explicit previews, exact backup/optional-field retention,
idempotence, stale writers, active daemon/configuration/supervisor barriers,
changes and I/O failures after backup, absence, malformed/future/cyclic/bounded
data, symlinks/hardlinks/directories/modes/UTF-8 and pre-existing temporary files.
CLI tests require refusal before credentials, network or skill writes and enforce
preview/confirmation. Native credential/service fixtures explicitly upgrade
their synthetic legacy inputs without weakening existing lifecycle assertions.

`npm run uat:profile` obtains the exact historical commit
`590782901000b40251030f79c722ddd5e1b4eaac`, builds its locked source, packages and
clean-installs both old and current CLIs into disposable roots. The old package
first successfully uses a legacy profile and creates a Drop mapping. The new
package previews/upgrades it and preserves the backup. Then historical status,
push, pull, sync, setup, Drop-add and workspace-attach must refuse without changes
to profile/credentials/native fixture files. The script reports artifact hashes
and verifies owned-fixture cleanup. It is required in the CI quality job.

The initial local historical-package drill passed all seven refusals. It is
evidence for those stopped-profile commands, not every historical release,
arbitrary credential/skill commands, active legacy processes, native harnesses,
power loss or independent hosts. Exact-candidate CI is recorded separately.
