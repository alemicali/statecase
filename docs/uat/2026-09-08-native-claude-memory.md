# Native Claude memory qualification — 2026-09-08

## Executed checkpoint

- Candidate: `cd736730eca04060ccaf29b86c1b4136a434010b`.
- [CI run 34209586836](https://github.com/alemicali/statecase/actions/runs/34209586836),
  native-claude job `102007136705`: completed successfully. The specific
  "Qualify native memory recall, writes and return transfer" step passed.
  The complete run subsequently passed all nine jobs.
- Native executable: Claude Code `2.1.263`; Node `v24.20.0`; Git `2.55.0`.
- Disposable GitHub-hosted Ubuntu 24.04 VM, runner image `20260831.293`.
- Entry point: `npm run uat:native-claude -- --memory`.
- Storage: encrypted in-memory reference backend. No live Worker, D1, R2,
  account, device capability, or operator native profile was accessed.
- Inference: deterministic loopback Anthropic Messages fixture. The native
  executable performed its own startup loading, session persistence and file
  Read/Edit/Write operations; this is not an autonomous hosted-model evaluation.
- Package: bundled engine/adapter source at the candidate SHA, not an installed
  npm CLI artifact. Independent-host packaged/cloud qualification remains open.

## Verified assertions — AD-MEM-008 subset

The source uses the repository-derived native memory directory. Its selected
Markdown index and topic have independent random markers that are absent from
every submitted user prompt. An unselected project has a separate marker.

1. A fresh source session sends the selected index in actual native startup
   context. The topic marker and unrelated-project marker are absent. Native
   Read loads the topic, native Edit changes it, and native Write updates the
   index. The fixture checks native tool results and resulting filesystem bytes.
2. Engine push creates encrypted objects and a capsule with a resolved memory
   topic dependency. Strict hydration preview changes neither target config nor
   applied state and does not create the initially absent target memory root.
3. Actual hydration reproduces the exact native-written index/topic bytes in a
   different custom target memory directory. The target's local
   `autoMemoryDirectory` setting stays byte-for-byte unchanged.
4. A different, fresh target session loads the transferred index, reads the
   transferred topic and updates both via native tools. Push and return pull
   reproduce those exact bytes on the source.
5. Another fresh source session includes the returned index in startup context.
   A fourth fresh session with native auto memory disabled excludes all index
   and topic markers. Both checks preserve the synchronized memory bytes.
6. Both unselected project indexes remain unchanged. The selected native roots
   contain only `MEMORY.md` and `project_context.md`; the encrypted collection
   descriptor is not materialized as a native file.

The fixed, redacted pass record reports four fresh sessions, 15 encrypted
objects and all assertions above as true. No prompts, paths, memory bytes or
native tool transcripts were published as logs/artifacts. Local evidence-guard
tests reject assistant history, tool results, prompt canaries, metadata-only
markers, forbidden project/topic markers and malformed requests.

## Executed location extension

Candidate `66f4e1fdd45a93f7f5bea782ee229d12f6261716`,
[CI run 34209964941](https://github.com/alemicali/statecase/actions/runs/34209964941),
native-claude job `102008351039`: completed successfully, including both the
existing native session drill and the expanded memory step. The exact memory
step pass record reports seven fresh sessions and these additional assertions:

- A detached linked Git worktree loads the original repository's returned index.
- A nested subdirectory of the repository loads that same returned index.
- A newly initialized unrelated repository loads its own index and excludes all
  selected-project index/topic markers.

All original transfer, edit/write, preview, local-setting preservation and
disabled-memory controls pass again. The executable, Node, Git and runner image
versions match the first checkpoint; the encrypted object count is still 15.
The three added location sessions perform no memory writes. They qualify native
location selection, not Statecase workspace-capsule transfer from worktrees or
automatic effective-location discovery by the CLI. The complete run subsequently
finished successfully in all nine jobs, including background synchronization.

## Executed same-session memory-reference extension

Candidate `6ac73fe4a71c802fb97cef5311e94978288c4194`,
[CI run 34211942704](https://github.com/alemicali/statecase/actions/runs/34211942704),
native-claude job `102014736920`: completed successfully, including the explicit
memory step. Claude, Node, Git and runner image versions are unchanged.

The extended drill retains all seven fresh-session assertions and adds an actual
native resume of the original source UUID on the target. In the first resumed
model request, all three historical memory Read/Edit/Write arguments point to the
target's memory directory. The original Read result still contains the old topic
marker, proving that historical output was preserved rather than replaced with
current content. A new native Read then returns the transferred topic bytes from
the target path. Resuming does not change the memory files.

After hydration, a target push is a no-op. After target changes, return transfer
and localization, a source push is also a no-op. These assertions check canonical
session bytes across physical path changes rather than merely file availability.
The redacted pass record reports the same seven fresh IDs plus the successful
same-UUID resume, all five new memory-history/resume/no-op flags true and 16
encrypted objects. The ordinary native session continuity step also passes.
The complete run subsequently finished successfully in all nine jobs, including
background synchronization and quality/workerd checks.

This qualifies the pinned Claude absolute structured file-path history used by
the fixture. It does not qualify relative references, freeform patches, old
absolute-history migration, mixed versions or independent-host packaged/cloud
execution. Prose, tool outputs and authored content are deliberately not path
rewriting inputs.

## Boundaries

This proves native index loading, on-demand topic reads, explicit native writes
and bidirectional engine transport for this pinned version and selected
locations. It does not prove hosted-model retention decisions, full settings
precedence, subagent memory, automatic location discovery, complete session
reference localization, independent-host/cloud/package parity, or Codex memory.
Statecase does not silently enable native memory during normal enrollment; the
test explicitly enables it only in synthetic fixture settings.

Full native location/precedence and generation coverage, AD-MEM-009..010 and the
overall public-release requirements remain open. Neither the four-session nor
seven-session reference drill is a substitute for the independent-host workflow.

Native behavior reference checked 2026-09-08:
[Claude memory documentation](https://code.claude.com/docs/en/memory). The
documentation motivates the test cases; only executed assertions establish the
Statecase evidence described here.
