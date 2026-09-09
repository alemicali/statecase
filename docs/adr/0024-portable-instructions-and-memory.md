# ADR 0024: Portable instructions and workspace-scoped memory

Status: accepted design; implementation in progress
Date: 2026-09-08
Test IDs: AD-CTX-001 through AD-CTX-009

## Required outcome and ownership

Instructions and memory are part of portable operational context, not optional
documentation about the sync product. This ADR does not remove configuration,
memory or any other outstanding release scope.

Global Codex `AGENTS.md` / `AGENTS.override.md` and Claude `CLAUDE.md` / user
`rules/**/*.md` belong to the selected harness home. Project instructions already
belong to Git/workspace capsules; do not give the same physical file a second
sync owner. Claude project auto-memory needs a separate opt-in, logical workspace
identity and namespace-level capability isolation. Path-derived project names
are local materialization details, never global memory identity. Global memory,
custom memory directories and subagent memories require explicit reviewed
selection; never ingest every project merely because its harness is selected.

## Global instruction representation

Use `portable-instructions/v1/<native-relative-path>` entries inside the harness
namespace. Keep native UTF-8 bytes intact; no arbitrary prose/path replacement.
Only adapter-reviewed entrypoints and Markdown include directories are writable.
The initial global registry is Codex's two AGENTS files and Claude's CLAUDE file,
rules Markdown tree and `instructions/` Markdown includes. Includes outside
reviewed roots fail explicitly rather than being read/copied automatically.

Validate instruction dependency closure on both publication and receipt.
Claude imports must resolve within the reviewed instruction registry and be
present in the same authenticated instruction set. An external/missing import
cannot silently produce a supposedly complete portable context. Never follow
links or import authority-bearing JSON/TOML, credentials, hooks, plugins or
executable definitions. Unsupported import syntax fails closed. Future Drop
imports require explicit selection, exact revision pins and reviewed native
path localization; general prose links are not auto-import permissions.

Bound each instruction to 1 MiB, the selected set to 256 files / 8 MiB and
dependency depth to four import hops. Observe through no-follow/nonblocking
descriptors, single-link regular-file and owned-directory checks; reject
unstable files/parents and redact errors. Observe the whole selected set again
before accepting it. Receiver writes/deletions use guarded all-or-rollback
transactions, per-file conflicts and owner-only replacements. Historical
restore still requires preview, emergency recovery and post-apply validation.

## Instruction write authority and rollout

Possession of a harness scope key does not authorize changing global
instructions. A read/append sandbox could otherwise introduce AGENTS.override.md
or a Claude rule through a valid encrypted patch. Client-only publish policy
cannot defend receivers from a modified client.

The coordinator records `commitMode` on immutable namespace revisions, current
heads and scoped checkpoints, derived exclusively from the validated commit's
`mode`. The HTTP authorization layer permits `replace` only with full namespace
write authority; read/append capabilities cannot obtain that provenance.
Receivers reject entries and tombstones under the entire reserved
`portable-instructions/` prefix in harness namespaces unless their own chain
segment has server-attested `replace` provenance. An append can inherit owner
instructions but cannot introduce, edit or delete them. Append snapshots are
valid only at an empty namespace origin; later append manifests must be deltas
whose sole parent equals the immutable server-recorded predecessor. Validate
the complete pointer identity before accepting that predecessor.

`GET /v1/vaults/:vaultId/namespaces` advertises `commitProvenance: 1`. Instruction
publish refuses older servers before uploading any objects, including the
legacy-vault migration path. Deploy and qualify the new Worker before enabling
this CLI feature against live storage. Legacy revisions lacking provenance
remain readable for existing non-instruction state only. This is a trusted
authorization-server boundary, not protection from a malicious cloud that
forges authorization metadata, nor an assertion that older-client fencing or
authority policies for every pre-existing settings/skills path are complete.

The Markdown import parser deliberately supports a conservative subset:
unquoted whitespace-delimited relative `@path` tokens, excluding fenced and
inline code and email addresses. Ambiguous tokens, cycles and external imports
fail closed; this is not a complete clone of the vendor Markdown parser.
Root-file absence and tree membership are observed again so a newly created
override/rule cannot be silently omitted merely because timestamps coincide.
Bounded double observation is not an atomic filesystem snapshot and does not
close all same-UID adversarial ABA or parent-rename races.

## Evidence required

- AD-CTX-001: strict path registry, virtual versions, byte/type/size bounds.
- AD-CTX-002: native import closure, cycles/depth, missing/external/unreviewed
  references and deterministic ordering; no raw diagnostic content.
- AD-CTX-003: descriptor/parent safety, symlink/hardlink/FIFO rejection,
  concurrent writes/replacements, absent roots, disposal and bounded reads.
- AD-CTX-004: encrypted two-device instruction transfer, preview, local-only
  preservation, convergence, deletion and conflict behavior.
- AD-CTX-005: hostile authenticated remote metadata/paths/imports; no native
  mutation or applied-marker advancement on rejection.
- AD-CTX-006: precommit races, multi-file rollback and historical recovery.
- AD-CTX-007: actual pinned native harness loads transferred global instructions
  on a fresh session; no prompt injection by the fixture can mask failure.
- AD-CTX-008: opt-in project memory, logical remapping, two-workspace scope
  isolation, custom-root selection, native reading/writing and return transfer.
- AD-CTX-009: authoritative commit provenance, append instruction additions/
  edits/deletions denied, inherited owner instructions retained, snapshot/parent
  bypass and mismatched pointers rejected, older-server upload refusal and
  actual workerd authorization/provenance persistence.

## Sources and remaining work

[Codex AGENTS discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
and [Claude memory](https://code.claude.com/docs/en/memory) were fetched on
2026-09-08. They establish native instruction/import locations and project
memory behavior, not Statecase security guarantees.

Global instructions are the first implementation increment. Workspace-memory
selection/materialization, full imported-context coverage, all native/version
cases, exact-package independent-host UAT and older-client fencing remain
required before full product completion.
