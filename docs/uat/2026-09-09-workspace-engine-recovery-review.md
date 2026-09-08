# Combined workspace/engine recovery review map

Date: 2026-09-09
PR: https://github.com/alemicali/statecase/pull/7
Comparison baseline: `04b6e06bf46b9e91fe21644708e32792bde16e3f`
Class: data-integrity/security-critical; no release promotion
Test IDs: RT-006, WS-034, BK-009, SY-011, SY-012, AD-MEM-005

This intentionally remains one integrated PR. Its size requires the following
review order; intermediate test/source commits are not separate product releases.

1. ADR-0035 and ADR-0036: authority, durable ordering, reference retention,
   scoped hydration identity, rollback and explicit remaining requirements.
2. `git-reference-participant.ts`: original/desired native reference validation,
   derived exact grants, stable bounded descriptor reads, packed/ref/reflog
   preservation, native configuration semantics, pin verification and retirement.
3. `config.ts` and `profile-checkpoint.ts`: original profile/mapping selection
   before Git acquisition, full preparation under the profile mutex, descriptor
   publication before native exclusion, common file/index/ref/profile decision,
   all-participant replay and receipt retention through native release.
4. `materialization-recovery.ts`: bounded 512 exact grants and installed pin
   ownership copied from the durable plan, never adopted from observed new files.
5. `sync.ts`: proposal before native mutation, immediate source guards, original
   profile observation identity, scoped-view/original-profile association and
   restoration of prior in-memory marker references on handoff refusal. Explicit
   historical restore retains its existing separate emergency lifecycle.
6. Reference/workspace/profile tests plus `engine-profile-recovery.test.mjs`:
   real bundled code, synthetic roots, actual SIGKILL and independent recovery,
   branch/packed/detached/unborn/linked layouts, native release faults, foreign
   pins, malformed metadata, substituted reads, stale profiles and source edits.
   Engine tests include session/Drop/Git/profile state and ciphertext canaries.
7. CI/implementation/test/threat/readiness/changelog deltas. Disposable macOS
   now includes the complete reference and encrypted-engine recovery suites.

Failing-first history: `c1fea90`, `242924b`, `fd277f5`, `84fd095`, `9757038`,
`7e3083d`; later boundary tests `bce0bbf` and `563bdc1`. Initial regressions
include absent full-workspace handoff/pins/reflogs, unsafe descriptor/text reads,
incorrect Git booleans, acquisition before stale/unselected/dry-run refusal,
uncoupled engine metadata and invalid scoped-hydration profile authority.

Final local evidence: all check steps pass, 1,342 tests/73 files. Reference
branches 96.13% (100% lines/functions), profile checkpoint 94.89%, changed engine
hydration/handoff region 90% (27/30), global 93.03% (5451/5859). Whole engine
86.77% and workspace 89.67% remain below their full critical-module targets.
An earlier 1,292-test check passed but reference branches were 79.22%; boundary
tests raised coverage without reducing gates. No existing test timeout was raised.

Prior exact baseline CI 34242219691 passed all nine jobs. New exact-candidate
CI remains pending until terminal results are recorded. Do not infer new hosted
qualification from the baseline, local tests or a successful workflow start.

No new dependency, public command, cloud schema, harness patch, live deployment,
merge or release. No real profile, keychain, credentials or bucket was used.
Version-three internal checkpoints reject downgrade/missing reference metadata;
recover them with the matching current implementation rather than changing their
version or force-removing locks. Native activity/command/daemon/shim enablement,
upload/no-op state publication, historical restore coordination, full dependency/
shared-index retention, other Git backends, all low-level faults/aliases/orphans,
mixed clients, latest packaged independent-host live-cloud UAT and independent
code-owner/security review remain required alongside every broader release gate.
