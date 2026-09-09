# Global instruction transport and authority qualification

Date: 2026-09-08
Candidate: `5dbecea60574222c60e0b2a158399aacbb0c5391`
Test IDs: AD-CTX-001..007, AD-CTX-009; AD-CTX-008 remains open
Status: local and selected native checks pass; full release gates remain open

## Native execution evidence

On the exact candidate above, both jobs in
[CI 34201242162](https://github.com/alemicali/statecase/actions/runs/34201242162)
are terminal success:

- [Codex native qualification](https://github.com/alemicali/statecase/actions/runs/34201242162/job/101980272643):
  pinned `codex-cli 0.153.4`; source and fresh target provider requests contain
  the transferred AGENTS.override.md marker and exclude the fallback AGENTS.md
  marker. Both files are preserved byte-for-byte on hydration.
- [Claude native qualification](https://github.com/alemicali/statecase/actions/runs/34201242162/job/101980272706):
  pinned Claude Code `2.1.263`; source and fresh target requests contain the
  transferred CLAUDE.md marker, reviewed relative include and unconditional
  global rule marker. All three native files retain their original bytes.

The entire run is terminal **success: all nine jobs passed**, including
authenticated background sync, Node 22/24 compatibility and Linux/macOS native
credential/service qualification. Both native summaries report Node `v24.20.0`
and explicitly set `nativeGlobalInstructions: true`; Codex additionally reports
`nativeInstructionOverridePrecedence`, Claude `nativeInstructionImports` and
`nativeGlobalRules`. Only these redacted result summaries were inspected;
raw native context and provider request bodies were not logged.

Instruction markers are independent random values written only into the
synthetic source files, never into user prompts. Fresh target sessions prevent
restored conversation history from satisfying the assertion. Negative unit
controls reject missing context, fallback markers, unsupported harnesses and
markers present only in tool metadata. Existing native UUID/history, mapped
workspace read/edit/write, return synchronization, model/effort and CLI-override
assertions remain enabled. These jobs use two synthetic homes on one disposable
VM, reference encrypted storage and deterministic loopback inference, not hosted
models, packaged cross-host or live-Cloudflare qualification.

## Local and Worker evidence

The candidate's complete local `npm run check` passed 722 tests across 52 files,
lint, type checking, coverage, build and clean-installed package smoke checks.
Global branches: 91.48% (3934/4300). New critical modules:
instruction scan/plan 95.89%, native descriptor observation 96.36%, instruction
path/import policy 96.87%.

A subsequent CLI error-contract regression reproduced internal exit `10` for
native instruction failures. The correction maps authority to `4`, concurrent
native mutation to `5`, and unsafe/invalid/incomplete context to `6`, preserving
the existing JSON envelope. Its complete local check passes 723 tests with the
same global coverage. That follow-up requires its own committed CI evidence;
the native job references above certify `5dbecea`, not an uncommitted worktree.

The separate workerd suite passed 12 tests, including real capability replace
denial and append provenance persistence in namespace heads, immutable revisions
and checkpoints. The deliberately injected ambiguous key-rotation exception
is expected and is not a failed test.

Security regressions first reproduced three missing-provenance failures. The
coordinator now derives immutable commit mode from the authorized request.
Receivers require full-write provenance for every instruction entry/tombstone
chain segment, including future reserved versions. Append manifests must retain
their authoritative predecessor; false snapshots, skipped parents and altered
pointer identity fail before native application. Honest scoped clients refuse
instruction additions, modifications and deletions without uploading objects.
Inherited owner instructions survive valid sandbox deltas. Old-server instruction
publication fails before uploads, including legacy-vault migration.

File regressions cover symlink/hardlink/FIFO/unsafe-parent rejection, bounded
content sizes and selected-set counts, closed/cyclic/missing/external imports,
same-size write timestamp collisions, new overrides and changed directory
membership. Raw enumeration errors are redacted and retained plaintext buffers
wiped. Two-device tests prove preview, no-op convergence, deletion and conflict
preservation. A precommit race proves an earlier instruction write is rolled
back while a concurrent local edit survives. Historical restore tests at key
epochs 1 and 2 exercise preview, physical-path emergency capture, failed remote
publication rollback, successful restoration/deletion and preservation of a
synthetic local-only authentication file.

## Remaining gates

No live Worker deployment was performed for this change. Deploy and qualify
server provenance before live instruction publication; the new CLI refuses an
older server. General mixed-client fencing remains required.

This is not complete memory portability: AD-CTX-008 workspace-scoped opt-in
memory, custom roots, subagent memory, full native import/precedence/version
coverage and explicit external Drop dependencies remain required. The import
parser supports a conservative reviewed subset, not every vendor Markdown
construct. Double observation is not an atomic filesystem snapshot; same-UID
ABA/parent races, persistent workspace crash recovery and resource-exhaustion
review remain release gates. Server provenance trusts the authorization server;
it is not a cryptographic sender signature. Broader authority policies for
pre-existing settings/skills, independent security review, packaged live-cloud
cross-host UAT and the other readiness gates are not waived.
