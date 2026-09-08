# Native memory patch continuity — 2026-09-08

Status: pinned native reference drill passed; public-release scope remains open.
Test IDs: AD-MEM-011, WS-022, UAT-02 subset.

## Executed candidate

- Candidate: `7adee1b52fb400bdcd85dc644cd9d55b66d1fa91`.
- [CI run 34215976635](https://github.com/alemicali/statecase/actions/runs/34215976635),
  native-codex job `102027686367`: completed successfully.
- Native executable: `codex-cli 0.153.4`; Node `v24.20.0`; Git `2.55.0`.
- Disposable Ubuntu 24.04 runner, image `20260831.293`.
- Actual Statecase engine/adapters/crypto; in-memory reference transport,
  deterministic loopback Responses provider, two synthetic homes on one host.
- Encrypted object count: 76. No operator native state, provider credentials or
  production cloud resources are used. Owned fixture directories are removed by
  the driver/scenario, and the hosted VM is disposable.

## Assertions observed

The real source harness executes one freeform patch with two Add operations:
an ordinary workspace artifact and a Markdown file in an explicitly selected
memory collection. Its actual persisted JSONL must contain the exact relative
memory header supplied to the native tool. The file is created by Codex, not
seeded by Statecase after the run.

Encrypted publication must expose both workspace and memory targets as resolved
Session Capsule dependencies. A strict hydration preview must leave target
files, applied state and local settings unchanged. Actual hydration restores
exact workspace/memory bytes without copying the native SQLite database.

Codex then resumes the original UUID in the target home and different checkout.
Its actual model request must contain the original patch with the selected
memory header localized to the target's absolute directory. Original prompt
history and tool output remain present. Native tools read the transferred
workspace artifact and execute Update operations for both files; filesystem
assertions require the target continuation bytes. Source files remain unchanged
until explicit return synchronization.

Target publication and source pull must return exact workspace/memory bytes.
Both the initial target push after hydration and the source push after return
must be no-ops. All prior native preference, CLI-override, global instruction,
device-local configuration and same-session assertions pass again.

The redacted pass record reports `nativeMemoryPatchWrite`,
`sourceRelativeMemoryPatchHistory`, `localizedMemoryPatchHistory`,
`memoryPatchDependency`, `exactMemoryPatchReturn` and
`canonicalNoOpRoundTrip` all true. This records a completed job, not merely
the presence of new assertions in the fixture. The entire CI run subsequently
completed successfully in all nine jobs, including quality/workerd/audit,
background synchronization, both Node versions, native Claude and macOS checks.

## Concurrent continuation follow-up

Candidate `37b1f7b07ca9d7988b2c42fd559f921f743772c5` passed native-codex job
`102034206805` in
[CI 34217993203](https://github.com/alemicali/statecase/actions/runs/34217993203).
Codex, Node, Git, runner image and reference topology are unchanged.

After target continuation/publication but before source hydration, the original
source harness now resumes that same UUID and appends a separate text-only turn.
Its actual request must still contain the original relative memory patch header,
and its memory file must retain the original bytes. This produces two native
branches over the same previously published history; the source continuation
is not fabricated by editing JSONL.

Source publication merges the branches and must retain its old applied harness
marker. Source pull then receives the target's workspace/memory changes and the
merged history. The source history contains exactly one concurrent text response
and exactly one target patch call. Source push is a no-op; a subsequent target
pull and push must also converge without creating another revision.

The native pass record adds `nativeConcurrentSessionAppend`,
`mergedAppliedMarkerPreserved`, `bothNativeBranchesRetained` and
`bothPeersConverged`, all true, with 78 encrypted objects. All prior original-
UUID, memory patch, preference/instruction, configuration, preview and return
assertions pass again. The complete run subsequently finished successfully in
all nine jobs, including quality/workerd/audit, background synchronization,
both Node versions, native Claude and macOS lifecycle/credential checks.

This qualifies the pinned two-branch native case with reviewed relative memory
references, not arbitrary concurrent operations or two live writers on one
native file. SY-012's injected late-write/rollback cases are separate local
engine evidence; this native drill does not inject a writer into the final
check/rename interval or simulate a killed materialization process.

## Boundaries

The collection is an explicit synthetic memory binding. This does **not** prove
Codex's automatic memory discovery, consumption, generation, subagent formats,
or effective native memory configuration. It qualifies native file-tool use and
session history portability for selected memory. No autonomous hosted-model
decision is inferred from deterministic fixture responses.

Local tests additionally cover Delete/Move headers, LF/CRLF retention, authored
header lookalikes, malformed complete-envelope rejection, unsafe or missing
bindings, streamed canonical restaging and ordinary/legacy encrypted returns.
Those are local assertions, not additional native operations in this drill.

Workspace raw patch filenames remain relative to the mapped checkout in this
fixture; arbitrary workspace/Drop patch-header localization is not established.
Concurrent cases beyond the selected two-branch drill, historical/mixed-client migration,
filesystem aliases, packaged independent-host/live-cloud parity and the broader
production/security gates remain required.
