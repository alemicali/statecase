# ADR 0038: Explicit operator recovery for interrupted local materialization

Status: implemented under qualification; ordinary runtime coordinator wiring pending
Date: 2026-09-09
Test IDs: RT-006, RT-014, BK-009, SK-001

## Context and test-first evidence

The complete file/Git/profile journal has a tested internal replay operation,
but an operator cannot invoke it through the CLI when pending state blocks
normal commands. Recovery must not depend on the possibly absent `config.json`,
enrollment, cloud reachability, a credential store or an encryption key. It also
must not race a daemon or a supervised native harness using the same state.

Commit `1b240cd` adds ten failing tests: actual SIGKILL at file/profile and
commit boundaries followed by CLI preview/confirmation, and refusal for held
daemon/config locks, tracked Codex/Claude processes, untracked native processes
and failed process inspection. `ae59e21` adds absence, held-barrier, changed-state,
malformed-authority and installed-package boundaries; its actionable error
assertion initially failed. `2544063` requires JSON to distinguish remaining
pending work from successful recovery and reproduces the missing result field.

## CLI and JSON contract

Add `statecase --json profile recover --dry-run` and
`statecase --json profile recover --yes`. Exactly one flag is required; neither
or both returns usage exit 2. The command bypasses normal pending-profile reads,
as the existing profile command group does, and delegates to
`ConfigStore.recoverProfile` instead of inventing a second replay algorithm.

| Result | `pending` | `recovered` | `dryRun` | `outcome` |
| --- | --- | --- | --- | --- |
| Preview with retained work | true | false | true | rollback or cleanup |
| Completed replay | false | true | false | rollback or cleanup |
| Nothing to recover | false | false | requested mode | none |

`targets` is the existing replay plan's aggregate target count, not file content
or paths. `cleanup` means the durable committed state is retained and transaction
artifacts are retired; it does not undo that committed state. None of these
results proves remote synchronization. Successful recovery does not start a
daemon or harness. Pending/integrity errors now point to the preview command.

## Admission, replay and refusal

1. Perform the existing non-mutating recovery inspection. An absent installation
   remains absent. Preview does not acquire runtime locks, inspect processes,
   open credentials or use the network. Invalid retained authority fails with
   integrity exit 6 before operator admission.
2. For confirmed pending recovery acquire the profile daemon mutex, then the
   Codex and Claude activity barriers in fixed order. Require native process
   inspection to find both harnesses stopped, including processes outside the
   supervised marker registry. This conservative profile-wide recovery policy
   is not the policy for ordinary independent Drop synchronization.
3. Invoke the existing coordinator, which acquires the config mutex and rereads
   retained authority/current fingerprints before mutation. Never reuse the
   preview as write authority. A change during admission preserves independent
   files and refuses replay. The original checkpoint supplies mappings even
   when the operational profile file is absent.
4. Keep outer admission barriers until replay/retirement returns, releasing all
   acquired handles on every success or failure. Existing config observation
   invalidation, native ownership checks, reference retention and durable paired
   commit/rollback rules remain in force.

Failure to establish or release exclusion is actionable exit 5 with a fixed
instruction to stop daemon/harnesses and inspect again. Never print raw process
arguments, inspection errors or credentials. Integrity refusal remains exit 6
with all evidence preserved; there is no force, unlock, checkpoint-edit or
automatic-recovery bypass. `CliIO.harnessProcessTable` is a trusted embedding/test
dependency, not a public flag or a serialized configuration option. Normal CLI
execution uses the native process inspector.

## Agent-native operation

The canonical skill teaches preview and explicit operator authorization, and
distinguishes this local transaction recovery from cloud historical restore and
emergency snapshots. An agent running inside Codex/Claude hands confirmed replay
to an external shell/provisioner after the operator stops harnesses; it must not
kill its own harness or bypass refusal. Skill-creator validation accompanies this
narrow update. No installed operator skill is modified during development.

## Alternatives, limits and compatibility

Calling internal replay directly from an ordinary command lacks runtime
exclusion. Automatically recovering during every startup could mutate native
state while another process uses it. Requiring credentials prevents local
recovery after logout or loss of cloud access. Removing locks/checkpoints makes
their ownership and durable decision unverifiable.

Activity markers and process inspection coordinate cooperative current clients;
they do not fence arbitrary manual writers, an untracked native process started
after inspection, or every old binary. Same-user barrier substitution, PID/format
history, all power-loss/I/O/ancestor races and mixed-writer qualification remain
open. Full activity-aware normal pull/daemon/shim/hydration integration and
preflight/child/final-flush ordering are still required. No claim that an active
incoming session can now be rewritten safely is made.

This adds an unreleased public CLI command, not a cloud or checkpoint format.
Older CLI versions lack the command and must not be used to bypass a pending
checkpoint; use a matching compatible implementation. No dependency, native
harness patch, enrollment or live deployment changes. Production promotion still
requires all readiness gates and independent code-owner/security review.

## Verification

`profile-materialization.test.ts` invokes the real CLI after an actual fixture
SIGKILL, including a missing profile, rollback and committed cleanup. It verifies
preview immutability, stopped-process barriers, malformed authority, late edits,
redacted errors, no credentials/network, released partial admission and idempotent
no-op. `engine-profile-recovery.test.mjs` now recovers encrypted session/Drop/Git
checkpoint fixtures through the operator coordinator in a fresh process using an
explicit synthetic process table. Existing exact native/profile comparisons stay
unchanged. The macOS job includes both suites. Package smoke uses the installed
CLI for no-op recovery with no profile/enrollment; it is not a full packaged
pending-recovery drill. Full check/coverage and hosted evidence are recorded in
the readiness review, not inferred from focused tests.
