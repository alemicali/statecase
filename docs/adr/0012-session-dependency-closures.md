# ADR 0012: Immutable session dependency closures

Status: accepted

## Context

Copying a native Codex or Claude transcript is not sufficient to resume work.
The transcript can reference a clean tracked file, an uncommitted workspace
overlay, an arbitrary Drop, or an external path that policy intentionally did
not upload. Pairing an old transcript with the latest workspace state can be as
incorrect as losing the transcript itself.

## Decision

Statecase records a `SessionCapsuleV1` in the encrypted vault manifest whenever
a portable native session changes. The capsule identifies its native harness
entry and pins the immutable vault revision containing the harness state,
workspace capsule, Git baseline, and every observed Drop. Structured native
tool events provide candidate paths; prompt prose is never treated as proof of
file access. Git/index capture and synchronized object identities remain the
authority for whether candidate content is actually present.

Dependencies are classified as:

- `git-baseline`, with a Git object ID and no uploaded tracked bytes;
- `workspace-overlay`, with the encrypted content identity when captured;
- `drop`, with a content identity and pinned Drop revision;
- `external`, unresolved until the operator maps and checkpoints a Drop.

Ignored, excluded, deleted, or otherwise absent content remains visible as an
unresolved dependency and is not silently uploaded. The CLI exposes inspection
through `statecase workspace dependencies` and exact historical materialization
through `statecase workspace hydrate --session ...`. Hydration modes are
`strict`, `warn`, and explicitly accepted `best-effort`. Harness, workspace,
and Drop pins may refer to different immutable vault checkpoints. The client
resolves and authenticates each pinned namespace chain, composes only those
namespace states, and sends them through one local filesystem/Git transaction.
A missing revision, namespace, manifest, or content object fails before any
target is changed.

## Consequences

Historical resume no longer substitutes the current workspace or Drop head for
the state observed by a session. Manifest metadata grows modestly and remains
end-to-end encrypted. Native adapter fixtures must evolve as harness event
formats evolve. OS-level read tracing remains optional; structured event
tracking is a completeness signal, while final Git reconciliation protects
writes even when an event is missed.

## Verification

Native Codex 0.153.4 qualification found that `apply_patch` is a freeform
`custom_tool_call`, not a JSON path argument. The extractor now recognizes its
bounded patch envelope and operation headers (including move destinations),
never path-like headings inside added/context text. These remain candidate
write references; filesystem/Git reconciliation proves captured content.
Arbitrary shell and code execution is not parsed or traced by this change.
An empty unresolved list proves only the extracted set is satisfied, not that
every opaque execution's external reads were observed. Coverage reporting for
that gap remains release work, without silently uploading external roots.

Protocol tests reject malformed dependency identities. Adapter tests cover
provider event variants, malformed arguments, narrative false positives,
duplicates, and unsafe relative paths. The two-device sync test proves clean
Git reads, overlays, Drops, excluded files, external paths, strict failure, and
historical hydration after the remote head has advanced. It also constructs
independent harness/workspace/Drop pins, verifies exact applied namespace
revision IDs, proves dry-run is non-mutating, and injects a missing pinned
object to prove the combined apply is atomic.
