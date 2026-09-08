# ADR 0031: One durable native/profile checkpoint

Status: internal coordinator implemented; Git and normal sync integration remain open
Date: 2026-09-08
Test IDs: RT-006, RT-014, BK-009, AD-MEM-007

## Context and failing-first evidence

A file-only journal is insufficient when `config.json` records the applied
revision and native session bindings after materialization. A crash can leave
new files with old markers, or temporarily remove the profile while moving its
original to a recovery backup. Recovery authority cannot depend on reading that
possibly missing or partially advanced profile.

Six initial failing tests specified exact paired file/profile replay. Subsequent
failing-first regressions demonstrated that a failed apply could still be followed
by a marker-only save of the same in-memory proposal, daemon stop was blocked while
the profile was absent, and substituted checkpoint metadata did not produce the
stable recovery-required contract.

## Decision

Add internal `ConfigStore.materializeConfig` and `recoverMaterialization` methods,
composing ADR-0030 under the existing config mutex. Normal sync/daemon/shim
reconciliation does **not** call the new materialization method yet: Git metadata
and native activity must join the same transaction before enabling it there.

The proposed profile may change only applied revisions/digests and session bindings.
Compare all other fields canonically, accommodating existing optional runtime
defaults. Scope changes, device/API changes and unrelated unknown-field changes
must use their own explicit configuration workflow. Unknown unchanged fields
are preserved. Reject stale/unobserved proposals before checkpoint publication.

Native target authority derives from the original persisted profile: harness/Drop
roots, explicitly bound memory roots and materialized workspaces. Identity-only
workspaces grant no file-write authority. Add an exact-file grant for `config.json`,
not its parent directory, credential siblings or journal subtree.

`FileTransaction.finalWrites` prepares metadata together with ordinary files but
installs it after all native writes, symlinks and deletions. The profile is the last
target. Recheck its original bytes immediately before that publication. The config
mutex is held throughout preparation, mutation, decision and retirement; cooperating
configuration writers cannot interleave an unrelated save.

## Outer checkpoint state

Publish private `profile-materialization.json` atomically before starting the file
journal. It contains version/id, the exact original framed profile, before/after
hashes, a phase and an optional settled receipt. It is bounded to twice the 16 MiB
profile bound plus 16 KiB for envelope/escaping. Reads use private owner-only,
single-link, no-follow/nonblocking bounded profile I/O with stability checks.

| Phase | Durable meaning | Missing file journal |
| --- | --- | --- |
| `prepared` | Original profile retained; native mutation not yet admitted | Cancel only if the current profile still exactly matches the original |
| `applying` | Complete file plan exists; native mutation may have started | Refuse: absence is not proof of success or rollback |
| `settled` | File journal decision and expected resulting profile hash recorded | Retire only if the resulting profile still matches the receipt |

After the file plan becomes durable, persist `applying` before the first native
mutation. Before the file journal may be forgotten, persist a settled receipt
matching its rollback/commit-cleanup decision and the resulting profile bytes.
Retire the outer checkpoint only after the file journal is absent and the receipt
or safe unstarted cancellation is verified. Fsync publication and retirement.

Recovery obtains roots from the retained original profile, even when `config.json`
is absent. It validates the entire file plan through ADR-0030. A settled outer
receipt must agree with the file journal before replay. Interrupted recovery can
restore the original profile first and then resume remaining native-file rollback;
normal readers remain fenced until the complete paired state is settled.

## Access fencing and administrative control

Current ConfigStore load/save/status/upgrade paths refuse pending outer checkpoints
or orphan active materialization journals with `PROFILE_RECOVERY_REQUIRED` (CLI
integrity exit 6). Loading checks both before and after reading profile bytes.
This is not a multi-file snapshot for an arbitrary concurrent reader.

Successful publication updates the observed proposal hash. Failed apply proposals
are invalidated, and actual recovery invalidates existing observations in the
recovering ConfigStore, preventing accidental subsequent marker-only saves from
those objects. This is not universal fencing of old binaries or arbitrary manual
configuration writers.

Daemon stop is administrative, not a request to resume work. It may read the
validated original profile through `loadServiceControlConfig`, which deliberately
does not create a save-authorized observation. The existing installed-service
ownership/profile checks still govern manager calls. Daemon start and normal
profile operations stay blocked. A synthetic CLI test proves this distinction
with the profile absent and a mocked service manager; no operator service is used.

## Alternatives and consequences

- Saving applied markers separately after file materialization leaves a crash gap.
- Writing the profile early exposes a revision whose native operations are incomplete.
- Treating a disappeared file journal as success silently accepts lost evidence.
- Deriving recovery scope from the current profile fails when it is missing or changed.
- Granting the profile directory would authorize credential/control-file siblings.
- Blocking every administrative command also prevents the operator stopping a daemon.

The original profile is transient local plaintext recovery metadata, not a cloud
backup or an authenticated remote snapshot. There is no credential read/copy,
network request, dependency, cloud schema or protocol-capability addition. The
outer checkpoint is rewritten at a fixed number of phase boundaries, not per
native file. Original-profile validation and metadata fsync still need performance
qualification at the supported size limits.

## Compatibility and remaining requirements

The internal APIs add no public sync/recovery command. Existing normal command
paths acquire a pending-state fence and daemon stop retains safe administrative
access, but ordinary sync still uses its previous materialization path. Do not
manufacture checkpoint files, remove them to bypass an error or advertise full
runtime crash recovery from these tests.

Before runtime enablement, complete durable Git HEAD/refs/index participants,
activity/hydration barriers, matched CLI/profile capability fencing and mixed-client
qualification. Older binaries do not know the new checkpoint fence. A profile
co-located inside a selected root still needs an excluded-control-subtree authority
design: the present internal primitive requires its journal outside directory
grants. This remains a scope/integration requirement, not a silently waived case.

Full low-level write/fsync/close fault coverage, power loss, pre-publication orphan
cleanup, malicious same-principal races/tampering, interrupted service control,
packaged cross-host/live-cloud UAT and independent security review also remain open.

## Verification

The real code is bundled into isolated processes with synthetic homes. Actual
SIGKILL/restart tests cover native installation, profile backup/installation,
outer publication, file-plan publication, mutation admission, settled receipt,
file-journal removal and repeated interruption while restoring the profile.
Tests verify exact original profile bytes, matching committed files/bindings,
non-mutating preview, stale proposal refusal/invalidation, mutex exclusion,
identity-only and metadata-sibling denial, malformed/private-file checkpoint
validation, missing-journal refusal, outer/inner decision agreement and daemon
stop while normal access is fenced.
