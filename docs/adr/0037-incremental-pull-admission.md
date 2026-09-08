# ADR 0037: Admit only advanced namespaces, require native Git discovery

Status: implemented under release qualification
Date: 2026-09-09
Test IDs: SY-011, SY-012, RT-006, WS-034

## Context and failing-first evidence

An unrelated Drop update caused pull to materialize every configured namespace,
including an unchanged harness namespace whose local session was still growing.
Test-first commit `ac1efa7` reproduced the resulting false conflict. Replaying
an unchanged namespace is also unnecessary download and native mutation work.

Separately, exact candidate `199d495` failed hosted run 34284910251 in quality,
Node 22/24 compatibility and native macOS. All four failures were the existing
reftable admission test; do not erase this evidence with a retry. The Linux
runner used Git 2.55.0, while local Git 2.43.0 had passed. A disposable build of
upstream tag v2.55.0 reproduced exit 1 from generic `git config --get` after
repository discovery rejected a version-zero repository with `refStorage`.
Adding `--local` instead returned exit 128. New test-first commit `73f4903`
reproduces the same unsafe fallback on Git 2.43.0 with an unsupported repository
version and an unknown version-one extension.

## Decision

First validate namespace authorization and missing-head checks against the full
configured selection, retaining existing empty-remote semantics. Then select
only namespace heads whose immutable revision differs from the local applied
marker. Resolve, download and materialize only that advanced selection. Preserve
unchanged applied marker objects and session bindings, even when another scope
commits. Never acknowledge a namespace that was not completely materialized.
Normal unchanged pulls perform no object downloads or coordinator calls. Explicit
session hydration already clears the applied markers on its narrowed view and
continues to hydrate its whole pinned closure; historical restore is unchanged.

Require repository discovery for the native backend query using
`git config --local --get extensions.refStorage`. Only exit 1 from that
repository-required query means the default files backend. Discovery failure,
unsupported extensions and other errors refuse preparation before allocating
reference parents/locks. Non-files backends remain refused by this participant.
This is not reftable support or a waiver of the full product requirement.

The [Git 2.55 setup implementation](https://github.com/git/git/blob/v2.55.0/setup.c)
rejects version-one-only extensions in a version-zero repository. Its
[config implementation](https://github.com/git/git/blob/v2.55.0/builtin/config.c)
requires an established repository for `--local`; generic queries can operate
outside one. The success fixture now tests a normal default-files repository,
not an explicit version-one extension attached to an invalid version-zero one.
The original reftable refusal is retained; version-one reftable metadata refusal
and invalid repository discovery add coverage rather than replace that guard.

## Alternatives and consequences

Reapplying every scope causes conflicts and inode replacement unrelated to the
remote update. Skipping all validation for unchanged scopes would weaken
authorization and conceal missing configured state. Treating generic config
exit 1 as proof of the files backend silently accepts failed discovery. Checking
warning strings would depend on Git wording and localization.

This change does not declare an active changed session safe to replace. Runtime
activity barriers, deferred incoming state, launch/final-flush ordering and
pending-recovery command wiring still need implementation and qualification.
The profile coordinator is still selected through the internal engine handoff;
ordinary command enablement has not been broadened by this fix. Git configuration
changes after admission and full backend/object-retention support remain open.

## Verification, migration and rollback

The independent-Drop test uses encrypted transport and the real ConfigStore
coordinator, preserves a locally growing session's bytes and inode, checks that
downloads belong only to the changed Drop, compares persisted applied state,
checks byte-identical dry-run profile preservation and tests a repeated no-op.
Existing whole-engine hydration/history/authority tests remain required.
Native reference tests run against both local Git 2.43.0 and a disposable
Git 2.55.0 build; full checks and exact-candidate hosted results are recorded in
the readiness review. No real harness, profile, credentials or bucket is used.

No dependency, public command, cloud schema or persisted format changes. Do not
promote an older unsafe admission path as rollback; retain the existing deployed
service until coordinated qualification. Keep all work in PR7. Independent
review and all previous production gates remain required.
