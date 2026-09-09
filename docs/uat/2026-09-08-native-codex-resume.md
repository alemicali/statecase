# Native Codex session continuity — 2026-09-08

Status: initial and managed return-sync drills passed; engine-level native-harness
qualification, not full product UAT
Test IDs: AD-CX-007, WS-022, UAT-02 subset

## Candidate and environment

- Product base: `7843114`, plus the freeform patch extraction regression fix
  and accompanying native scenario in this change.
- Codex: `codex-cli 0.153.4`, freshly installed from `@openai/codex@0.153.4`.
- Node: 22.22.3; Git: 2.55.0; Debian GNU/Linux 13, Linux x86_64.
- Dedicated private Daytona sandbox:
  `120faed2-8219-4da3-bc47-6f5abe0bc6cf`, snapshot `daytona-small`.
- Executed scenario bundle SHA-256:
  `4c56908aa543b0ff7fc5f9c8dadaa8df6527e6f11254908be4878c1070ea79f3`.
- Source and target were independently generated homes/checkouts in that one
  sandbox. Both Git repositories began unborn. No native SQLite database was
  copied or manually indexed on the destination.
- The actual Statecase `SyncEngine`, client, crypto, adapters, and workspace
  code were bundled unchanged apart from the recorded regression fix. The
  transport was an in-memory reference store, not a deployed Worker.

The native harness connected only to a deterministic loopback Responses
fixture. No hosted inference or model-provider credentials were used. Model
selection quality is not tested: the provider emits predetermined native tool
calls, while the real harness executes tools and persists/reloads its own state.

## Acceptance evidence

1. Real Codex executes a read of the fixture input and creates a new artifact
   through its native freeform `apply_patch` tool. The driver checks both the
   tool exit status and actual resulting file bytes, not just the overall CLI
   exit code.
2. Statecase encrypts and publishes native session JSONL plus the Git overlay.
   The reference object store rejects any object containing the generated
   plaintext canary. The successful run stored 62 encrypted objects.
3. The Session Capsule reports the patch target as a resolved workspace-overlay
   dependency. Strict hydration preview leaves destination bytes and applied
   state unchanged.
4. Strict hydration materializes the session and both input/artifact files
   under a different home and workspace path. The destination native SQLite
   directory is still empty before Codex starts.
5. `codex exec -C <target> resume --json <original-uuid> <new-instruction>`
   reopens the original UUID. The new instruction does not repeat the canary;
   the provider verifies the restored original prompt and original tool output
   in Codex's model-visible request.
6. Native target tools read the transferred artifact, report the target CWD,
   and modify its bytes. The originating file stays unchanged.
7. The scenario returns `result: pass` with every acceptance flag true and
   removes its generated home/config/session/workspace files. Native process
   groups are bounded and cleaned even if a harness fails or times out.

The final scenario passed repeatedly in Daytona. Local `npm run check` passed
455 tests in 35 files, 90.36% branch coverage, lint, typecheck, build, and clean
package installation. The common adapter reports 98.47% branch coverage.

## Defect found and corrected

The first native transfer resumed successfully, but its dependency report was
empty. Codex 0.153.4 records `apply_patch` as `custom_tool_call` with a freeform
patch string; the extractor previously accepted only JSON-shaped path
arguments. Git reconciliation correctly carried the written bytes, but the
activity report omitted the native patch target.

Two regression tests failed before the fix. The parser now recognizes the
patch envelope and operation headers, including source/destination of a move.
It ignores patch-body lookalikes, incomplete/unsupported envelopes, unsafe
relative paths, and ordinary prompt prose. Additional boundary tests and a
sync-level dependency assertion cover this path. The native drill now requires
the artifact dependency explicitly, so an empty report cannot pass again.

## Reproduction and isolation

Run `npm run uat:native-codex` with an absolute `STATECASE_UAT_CODEX` executable
and absolute `STATECASE_UAT_PARENT` outside `/tmp`. The launcher builds a
temporary scenario bundle; the scenario creates and cleans a private fixture.
No fixtures, provider handlers, or reference transport enter the CLI package.

On the operator host, Codex's nested sandbox initially failed to configure its
network namespace (`bwrap` / `RTM_NEWADDR`). We did not weaken the operator's
harness. The dedicated Daytona container instead used the explicit
`STATECASE_UAT_CODEX_SANDBOX=externally-isolated` and
`STATECASE_UAT_CONFIRM=run-native-harness-in-disposable-sandbox` controls.
The default remains `workspace-write`. This follows the official guidance to
use full access only within an already isolated environment:
[Codex permission configuration](https://learn.chatgpt.com/docs/config-file/config-advanced).
The original UUID/CWD resume flow follows
[Codex developer commands](https://learn.chatgpt.com/docs/developer-commands).

The dedicated CI job repeats the scenario in a fresh GitHub-hosted runner VM
with pinned Codex and no external credentials. CI evidence is recorded
separately from the Daytona result.

## Remaining boundaries

This does not qualify packaged CLI enrollment/supervision plus live Cloudflare
plus native resume as one combined path; nor a physical second host, hosted
model inference, Claude resume, interactive session pickers, `--last`, other
harness versions, concurrent native writers, machine reboot/sleep, or historical
recovery of a real-version session.

Most importantly, arbitrary shell/code execution can read files without a
structured path argument. This driver does not claim to trace those reads.
Its input survives because the Git workspace overlay captures it; the parser
does not derive that read from `exec_command`. A clean strict report therefore
validates extracted dependencies, not universal observation coverage. Explicit
coverage reporting and appropriate refusal/warnings remain required before an
unconditional complete-context portability claim.

Cloudflare resources, accounts, allowlists, and real harness profiles were not
modified in this drill. Disposable sandbox cleanup is verified separately below.

## Cleanup evidence

The driver removed its newly generated fixtures on every completed run. The
dedicated sandbox was then deleted by its exact ID. A subsequent filtered
Daytona inventory showed it absent and only the pre-existing unrelated sandbox
remaining. This also removed the exploratory native probes and test-only
installed binaries; those disposable remote files are not recoverable. No
unrelated sandbox, process, real session, provider credential, or Statecase
profile was changed. Local non-secret test driver/bundle artifacts may remain.

## Follow-up: sync launched inside the mapped checkout

The first CI native job passed at `7785e62`:
[native Codex job](https://github.com/alemicali/statecase/actions/runs/34179467005/job/101915404316).
Subsequent review found a separate CWD-dependent defect in streamed path
normalization. `path.resolve` was applied to every string; when the process
already ran inside the mapped workspace, even `session_meta` and model names
could become portable path URIs. A new regression reproduced that corruption
before the one-line absolute-path guard was added. Local `npm run check` then
passed 456 tests with 90.40% branch coverage.

The current native scenario additionally runs sync from inside both mapped
checkouts and publishes the resumed target changes back to the origin. These
extensions are separate from the earlier Daytona bundle/hash and must be
qualified by their own CI run. The destination-resume requirement and all
reference-storage/loopback-model limitations remain unchanged.

The extended [native CI job](https://github.com/alemicali/statecase/actions/runs/34179670847/job/101916018432)
failed. A second dedicated Daytona sandbox,
`5522de78-09ef-4542-910e-1db5dc934971`, reproduced `SyncConflict` specifically at
`return-pull`; native source, encrypted transfer/hydration, target resume, and
target publication had completed. The original workspace was still Git-dirty
from its already-synchronized overlay. The ordinary pull preflight rejects all
Git-dirty destinations rather than comparing them to their last-applied
authenticated capsule. A focused WS-034 regression with distinct staged and
worktree bytes reproduces the same failure locally at `sync.ts`'s workspace
preflight. That run exposed a product defect, not a passing complete
round-trip UAT. No reset, forced overwrite, or workaround was used to pass it.

The second sandbox's generated fixtures were cleaned by the scenario. The
exact sandbox was then deleted; subsequent inventory verification is recorded
by its absence from the filtered inventory, which showed only the pre-existing
unrelated sandbox. Neither run touched real harness state or Cloudflare.

## Managed return-sync rerun — 2026-09-08

The current WS-034 candidate fixes the managed-dirty false conflict using exact
authenticated prior-namespace verification, separate index staging, native Git
index exclusion, and per-target pre-commit stability guards (ADR-0020).

- Source: `fef9e7d` plus the WS-034 worktree candidate, not a released package.
- Dedicated sandbox: `0eeaf742-4e7b-4cf4-8137-92cd5ebd8bcb`, freshly created
  from `daytona-small`; it did not reuse either earlier test sandbox.
- Executed scenario bundle SHA-256:
  `d6add162811cde477c286cfea6d5c29355fd41d83be4a6feb21533c80a42ab50`.
- Pinned Codex `0.153.4`, Node `22.22.3`.
- Exit code 0; result `pass`; encrypted object count 67.
- Passed assertions: same original session UUID, original history/tool output,
  native read/write, mapped CWD, no native SQLite transfer, patch dependency,
  non-mutating hydration preview, unchanged source before explicit sync,
  return-sync of the resumed file changes, and sync executed from each mapping.

This is still the actual engine/crypto/adapters with an in-memory reference
backend and deterministic loopback Responses fixture. Two generated homes and
Git workspaces are on one disposable host. It is not a packaged/live-Cloudflare,
two-host, hosted-inference, Claude, or interactive-picker qualification.
The isolation follows the official [Codex command safety guidance](https://learn.chatgpt.com/docs/developer-commands):
native unrestricted execution is confined to the dedicated disposable sandbox,
with explicit synthetic HOME/CODEX_HOME/SQLite paths and whitelisted environment.
No real provider credential, native session, or production Cloudflare state is
used. Skill used for this qualification: `openai-docs`.

The corresponding local `npm run check` completed successfully: 479 tests in
35 files; 90.18% global branch coverage (3143/3485); typecheck, lint, build, and
clean-prefix package installation smoke passed. The workspace package's
87.98% branch coverage and ADR-0020's remaining race/crash/LFS gates are not
waived by this result. The existing remote CI still refers to the earlier
commit and is not evidence for this local candidate.

The driver removed the generated fixtures. The sandbox was deleted by its
exact ID after the successful run; final absence is verified with an ID/name/state-only
inventory, without displaying sandbox environment variables or credentials.
