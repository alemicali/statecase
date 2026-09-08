# ADR 0025: Explicit memory identity and local bindings

Status: accepted design; implementation in progress
Date: 2026-09-08
Test IDs: AD-MEM-001..010, AD-CTX-008

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

## Sources

Fetched 2026-09-08: [Codex memories](https://learn.chatgpt.com/docs/customization/memories)
and [Claude memory](https://code.claude.com/docs/en/memory). These describe native
behavior; they do not establish Statecase compatibility or security guarantees.
