# Native Claude session continuity — 2026-09-08

Status: native engine-level round trip passed; not full product UAT
Test IDs: AD-CL-002, AD-CL-006 subset, WS-034, UAT-03 subset

## Candidate and environment

- Product source: `0e788fd637b6224ea5dc7c59b0d6e0675bb663e7`; no product
  source changes were required by this drill. Test drivers and CI job accompany
  this report as new files.
- Actual Claude Code `2.1.263 (Claude Code)`, installed from pinned
  `@anthropic-ai/claude-code@2.1.263`; Node `22.22.3`.
- Dedicated Daytona sandbox `5dd5057c-7291-4b28-b5d6-4479a45e2ac0`,
  snapshot `daytona-small`.
- Final executed scenario bundle SHA-256:
  `2c9abf2cc4bfb9a17fcc15b20c45492fbf90274730e24ec69290eb44f89d191d`.
- Two generated homes and two Git checkouts on **one** disposable host. Target
  clones the source's committed synthetic baseline before native source edits.
- Real Statecase engine, client, crypto, adapters, and workspace implementation;
  test-only in-memory reference object/revision transport, not Cloudflare.
- Deterministic loopback Anthropic Messages fixture drives real native tools.
  No hosted inference, provider account, or existing harness profile is used.

## Acceptance evidence

1. Native source Read returns a tracked input's actual bytes; a second Read
   precedes Edit of the tracked artifact. Write creates an untracked note.
   The fixture checks successful native tool results and resulting file bytes.
2. The engine publishes encrypted native session and Git-overlay data. The
   reference store rejects the generated plaintext canary in object bodies.
3. The Session Capsule lists all three file paths as resolved dependencies.
   Strict hydration preview leaves applied state, native target state and the
   target's baseline artifact unchanged.
4. Strict hydration puts the native session in Claude's project-path encoding
   for the different target checkout. The baseline provides tracked read-only
   input; the overlay restores the edited artifact and untracked note.
5. Actual `claude --resume <original-uuid> -p ...` reopens that UUID. The new
   prompt does not contain the source canary. The loopback provider checks the
   complete original prompt in a user text message and the prior native Read
   output in tool results, not merely the marker appearing somewhere in history.
6. Native target Read/Edit continues work on the transferred artifact. Source
   bytes remain unchanged until explicit return synchronization.
7. Target push followed by source pull reproduces the continuation at origin
   without a forced reset. Each mapping retains one native session binding.

The final run exited 0 with every acceptance flag true and 11 encrypted objects.
A preceding successful run had bundle SHA-256
`5ae035392dadb8bfbca1f912667e7d88134802a37f07da0d796aca1f22bde68c`;
the final run strengthens the exact original-prompt assertion.

## Failed attempts preserved

The first two attempts executed all five source model steps but failed closed
because the fixture rejected an additional runtime request. Metadata-only
diagnostics identified `HEAD /api/hello`. The provider now responds to that
exact health probe with a bounded count, while refusing other unexpected
methods/routes and extra model turns. This was a simulator correction, not a
product workaround. No session, workspace, or adapter check was weakened.

## Reproduction and isolation

In a disposable VM/container, install the pinned harness and run
`npm run uat:native-claude` with absolute `STATECASE_UAT_CLAUDE` and
`STATECASE_UAT_PARENT`, plus
`STATECASE_UAT_CONFIRM=run-native-harness-in-disposable-sandbox`.
The scenario uses a child environment allowlist, fresh HOME/config/temporary
roots, an empty explicit MCP configuration, and restricted Read/Write/Edit
tools. Native children have bounded runtime, closed input, and process-group
cleanup targeting only their own spawned group. Native stderr and transcripts
are not forwarded by the launcher. The test-only provider and transport are
not included in the CLI package.

The restricted/tool-list and UUID-resume configuration follows the official
[Claude CLI reference](https://code.claude.com/docs/en/cli-usage). The isolated
config root, loopback gateway, and disabled nonessential traffic follow the
[environment-variable reference](https://code.claude.com/docs/en/env-vars).
This is file-tool qualification, not proof of network-level egress isolation.

## Quality and remaining gates

The local `npm run check` completed successfully: 498 tests across 35 files,
90.39% global branch coverage, lint, typecheck, build, and clean-prefix package
installation smoke. Workspace coverage remains 88.88%, below its critical-code
target; this drill does not waive that gate. CI evidence for the new native job
must be recorded separately for its actual commit.

The dedicated `native-claude` CI job subsequently passed on
`f689e32d23dc94a3c78e6257b8a208a8437f15eb` in
[run 34183506133](https://github.com/alemicali/statecase/actions/runs/34183506133),
using Node 24 and the pinned native Claude version in a fresh hosted Linux VM.
The existing native Codex job passed in the same run. These are the same
reference-backend/deterministic-provider scenarios, not cross-host live UAT.

Not qualified here: packaged CLI enrollment/shims/daemon combined with native
resume over live Cloudflare; a physical second host; hosted model inference;
interactive session listing or `--continue`; runtime pre-apply compatibility
validation; other Claude versions; concurrent native writers; reboot/sleep;
historical native-session restore; external/opaque shell read completeness.
Read/Edit/Write paths in this fixture are explicit structured file arguments.

## Cleanup

The scenario removed its generated homes, sessions and checkouts on each
completed run and wiped its owned key buffer. The dedicated sandbox was deleted
by its exact ID; subsequent filtered inventory showed it absent and only the
pre-existing unrelated sandbox remaining. Deletion also removed test-only
installed binaries and disposable remote bundles; those files are not
recoverable. Local non-secret driver bundles may remain. No real harness state,
Cloudflare resources, or unrelated sandbox was changed.
