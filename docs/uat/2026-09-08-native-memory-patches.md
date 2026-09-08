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
Concurrent representation-changing appends, historical/mixed-client migration,
filesystem aliases, packaged independent-host/live-cloud parity and the broader
production/security gates remain required.
