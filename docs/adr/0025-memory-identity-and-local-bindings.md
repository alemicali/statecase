# ADR 0025: Explicit memory identity and local bindings

Status: accepted design; implementation in progress
Date: 2026-09-08
Test IDs: AD-MEM-001..011, AD-CTX-008

## Requirement

Carry native agent memory as operational context without silently reading every
project or confusing machine paths with ownership. Global instructions are not
a substitute for generated recall memory. Codex global memory and Claude
repository memory require different identities; subagent/custom memory remains
part of the target product, not implicitly satisfied by either category.

## Identity, selection and permissions

Each explicitly selected memory collection has an immutable user-chosen ID and
its own `memory:<id>` namespace/scope key. Its local binding identifies the
harness namespace, native memory category, optional logical workspace ID and an
explicit absolute native directory on this device. IDs, not paths, match peers.
A Claude repository collection MUST reference a configured logical workspace;
a Codex global collection MUST NOT claim workspace isolation. Each device binds
the same collection ID to its own native location. Selection is opt-in: ordinary
harness setup does not enable or scan memory.

The encrypted collection descriptor MUST also authenticate the native category,
harness namespace and optional workspace ID. Before materialization, compare it
against the local binding: matching a user-chosen collection ID alone cannot
prove that peers assigned it the same project/category. Local physical paths
must never appear in this remote descriptor. Missing, mismatched or conflicting
descriptors fail before any native write; immutable historical pins retain the
descriptor together with its memory bytes.

Memory bindings are distinct from arbitrary Drops. Derive internal mappings
with a memory policy marker, so native Markdown validation, bounded descriptor
reads and transactional materialization cannot be bypassed by a generic Drop
path. Reject duplicate IDs, overlapping selected memory roots, Drop ownership
collisions and mismatched/missing harness or workspace identities. Never change
native memory settings, silently enable generation/use, or rewrite arbitrary
memory prose and paths. A mapping is not evidence that the native harness is
actually loading it; native location qualification is a separate requirement.

A sandbox receives a memory namespace key only through an explicit grant.
Granting project A's sessions/workspace/memory must not disclose project B or
global Codex recall. Read/append permission is permission to propose updates to
that explicitly granted memory collection, not to change global instructions.
Use the existing immutable append ancestry and conflict rules, with the same
preview/recovery guarantees as owner updates. Memory content can influence an
agent: granting its write scope is a behavioral trust decision, not merely a
storage permission. No sanitization claim is made.

## Native locations and content

The first native categories are `claude-project` and `codex-global`. Claude's
default repository memory directory is under its configured projects tree;
worktrees share repository memory. Current documented project-name and
autoMemoryDirectory overrides can change that directory. Explicit native
directory selection is supported before claiming automatic effective-location
discovery; full settings/environment/CLI precedence and rebind validation remain
required. Codex documents generated memory under CODEX_HOME/memories without
promising that arbitrary file copies reproduce all generation metadata. Native
read/use/write tests must establish support for a pinned format/version.

Transport reviewed UTF-8 Markdown with native bytes unchanged, bounded by
file/set limits, stable no-follow observations and an explicit format version.
Do not copy credential files, SQLite databases, caches, executable definitions
or arbitrary external references. Unknown native formats fail explicitly.
Directory enumeration itself must be bounded, not merely the number of names
processed after an unbounded allocation.

## Complete integration required

- AD-MEM-001: opt-in local binding, stable IDs across different paths, category/
  harness/workspace validation, duplicate and ownership collision rejection.
- AD-MEM-002: bounded memory Markdown enumeration/read, unsupported formats,
  unsafe links/parents, race checks and error redaction.
- AD-MEM-003: encrypted two-device round trip, preview, no-op, edit/delete and
  concurrent conflicts without affecting unselected collections.
- AD-MEM-004: namespace capability isolation, explicit append permission,
  expiration/revocation and malformed remote metadata denial.
- AD-MEM-005: Session Capsules pin selected memory revisions, historical closure
  hydration and GC reachability; missing memory never silently becomes complete.
- AD-MEM-006: transactional apply, historical restore, key rotation and failed
  publication rollback; preserve native state outside the selected collection.
- AD-MEM-007: CLI selection/list/rebind/removal, JSON/exit contracts, dry-run,
  programmatic setup and agent-native skill documentation.
- AD-MEM-008: real pinned Claude fresh-session recall, native memory writes and
  return transfer across distinct paths; custom-root and repository/worktree
  location cases, with unrelated project recall absent.
- AD-MEM-009: real pinned Codex memory consumption and generation continuity,
  explicit global grant, no accidental claim of project isolation.
- AD-MEM-010: daemon/shim parity, independent-host packaged live-cloud UAT,
  mixed-client fencing and safe unsupported native-version handling.
- AD-MEM-011: portable typed memory references in native tool history; exact
  canonical round trips, same-session resume, missing/wrong-owner denial,
  relative and absolute paths, reviewed freeform formats and historical migration.
  Never rewrite prose, tool results or authored artifact content to satisfy it.

## Implementation checkpoint

Engine transport uses canonical encrypted descriptor
bytes and a shared guarded native-text transaction planner. Capsules now carry
optional bounded unique `{memoryId, revisionId}` pins and `memory` dependencies.
Hydration filters unrelated configured collections, resolves independently
pinned checkpoints, and refuses missing/wrongly owned required memory. Explicit
selection changes refresh capsules without requiring transcript changes; a
memory-only change preserves an unchanged session's prior pin. Restore keeps
the native policy marker and never creates a physical descriptor file. The
subsequent local CLI contract adds preview/confirmed map, list, rebind and removal;
memory IDs remain immutable in category/harness/workspace, and local path changes
clear prior applied state. Kernel-serialized optimistic config saves reject stale
updates and inverse ownership collisions. Watch/service roots include selected
memory, with explicit service refresh after root changes. The bundled skill and
clean-package checks exercise that contract. Local
unit/integration evidence does not close full AD-MEM-008..010, native format/location
qualification, complete reference localization or independent-host/live GC UAT.

The first pinned Claude native memory drill passed on `cd73673`: four fresh
sessions with default/custom-root startup recall, native topic Read/Edit and
index Write, exact encrypted transfer/return and a disabled-memory control.
See [executed evidence](../uat/2026-09-08-native-claude-memory.md) for its
reference-backend boundaries. The seven-session extension on `66f4e1f` also
passed native worktree/subdirectory shared recall and unrelated-project startup
isolation. This is selected AD-MEM-008 evidence, not all native-memory support or
automatic effective-root discovery.

## Typed reference checkpoint

Reviewed absolute tool path arguments now use `statecase://memory/<id>/<path>`
inside encrypted session records. The owning harness selects eligible bindings;
Claude workspace ownership is checked before source conversion and destination
localization. Safe directory references are supported as well as files. Unknown
IDs, wrong projects, ambiguous bindings, unsafe suffixes and recognized opaque
tool formats that would require an unsupported memory rewrite fail with fixed
`MEMORY_REFERENCE_UNRESOLVED` (integrity exit 6). Other projects are not guessed
from matching directory names. Missing bindings fail before native materialization.

Only reviewed top-level path fields in structured tool inputs are transformed,
including JSON-string arguments and nested function envelopes. User/assistant
prose, tool output, edit replacements and Write content retain their native
values. Streamed push/localization/append inspection and legacy buffered paths
share the policy. Root resolution is compiled per file; traversal is bounded.
Global memory references can be localized in an unbound session, without claiming
that such a session has a workspace capsule. Failed staging is cleaned up.

AD-MEM-011 is not complete: relative memory paths, native freeform patch-header
conversion, complete historical-reference migration, physical aliases and
mixed-client fencing still require implementation/qualification. Already-published
absolute paths are not inferred or rewritten from prose; a source-side canonical
rescan is a format change whose append/migration compatibility must be qualified
before live rollout. The native Claude drill now attempts same-UUID resume with
localized historical Read/Edit/Write paths and a native Read from the target
memory root; its new exact-candidate CI result must be recorded separately.

That same-UUID native extension passed on `6ac73fe` in job `102014736920` of CI
`34211942704`, including all prior fresh-memory/location controls and no-op pushes
after target hydration and source return. The report records the reference
topology and exact assertion boundaries. This does not close the remaining
relative/freeform, historical migration or cross-host requirements above.

### Relative reference implementation checkpoint

Canonical relative memory paths now resolve from explicit native cwd observations
as records are processed, never from the running Statecase process or a guessed
workspace root. Reviewed session/turn metadata and Claude assistant/user record
metadata update that context; prose and nested artifact/tool data cannot. Missing
or invalid cwd with a selected collection fails closed for relative file-tool
arguments. Canonical leading parent segments and `./` are supported; ambiguous
noncanonical traversal/separators are rejected rather than normalized through
possible filesystem aliases. Category/harness/workspace checks still apply.

Memory conversion precedes workspace URI conversion, preserving native cwd
evidence. Activity extraction sees source-local normalized memory fields, so
parent-relative memory reads contribute real logical dependencies rather than
being omitted by the generic relative-path policy. Buffered and streamed paths
share the rule. The native drill now supplies relative memory arguments and
requires them to be present in source history before testing original-UUID
target resume. Its exact-candidate result is pending execution. Freeform patches,
complete migration, physical aliases and mixed-client fencing remain open.

### Native applied-baseline correction

The first relative-native candidate `5c127a8` failed during the return phase of
CI `34213273513`; the other eight jobs passed. A local failing-first regression
reproduced a false source-session conflict: push recorded the portable session
digest as the applied native-file baseline, while relative-to-absolute
materialization also prevented the literal history-supersequence fallback.

Applied session digests now hash the captured native complete prefix, using the
original accepted staging file (or accepted native bytes in the buffered legacy
path). Remote content digests remain hashes of the portable representation.
Never compute this baseline by rereading the live source after upload: edits
made after capture must not become overwrite consent. Tests cover ordinary and
buffered legacy returns, edits during upload/after push, and incomplete tails
present before or after capture. Real uncaptured changes still refuse pull and
preserve native bytes, memory and applied state. Historical/mixed-client and
concurrent representation-changing append qualification remain required.

The corrective candidate `7d130ab` subsequently passed the native memory step in
job `102023418948` of CI `34214643016`, including actual relative source history,
original-UUID target resume and source return/no-op checks. The executed report
preserves the earlier failed candidate and the limited reference topology; the
remaining freeform/concurrency/migration/cross-host requirements are not waived.

### Freeform patch implementation checkpoint

Reviewed raw `apply_patch` tool inputs now transform only Add/Update/Delete File
and Move-to header paths. A shared parser validates the whole envelope before
calling a path mapper, so malformed later lines cannot produce partial activity
or conversion. It rejects repeated/late move headers, invalid bodies, controls
and overlong paths. Original line endings, trailing whitespace, hunk context and
added/deleted text remain exact, including strings resembling headers or URIs.
Canonical relative memory headers use explicit native cwd; missing/unsafe/wrong-
owner bindings fail with the existing redacted integrity error. With selected
source memory, malformed raw patches fail closed even when relative filenames
do not spell the absolute binding. Streamed and buffered engine paths share it.

Tests cover header round trips, rejected formats, untouched content, dependency
activity and encrypted ordinary/legacy return. The native Codex scenario now
requires a relative memory patch in source history, localized historical input
on actual resume, target patch execution and exact/no-op return. Its execution
must be recorded separately; this is not native automatic-memory qualification.
Workspace/Drop raw patch paths, arbitrary tool formats, old-history migration,
mixed clients and concurrent representation-changing appends remain open.

The pinned native patch extension passed on `7adee1b` in job `102027686367`
of CI `34215976635`, including relative source history, original-UUID resume,
localized memory header, actual target patch writes and exact/no-op return.
See [executed evidence](../uat/2026-09-08-native-memory-patches.md); it is not
Codex automatic-memory or independent-host packaged/live-cloud qualification.

## Sources

Fetched 2026-09-08: [Codex memories](https://learn.chatgpt.com/docs/customization/memories)
and [Claude memory](https://code.claude.com/docs/en/memory). These describe native
behavior; they do not establish Statecase compatibility or security guarantees.
