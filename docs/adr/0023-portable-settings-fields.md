# ADR 0023: Portable preferences as guarded, per-field native-file edits

Status: implemented locally; native/package/cloud qualification in progress
Date: 2026-09-08
Test IDs: AD-CFG-001 through AD-CFG-012, SY-011

## Decision and scope

Transfer reviewed preference fields, never entire mixed-authority configuration
files. Harnesses continue using their normal local files. Codex's user
`config.toml` and Claude's user `settings.json` are the first documents, resolved
under the explicitly selected harness mapping. No additional server, auth
scheme, or secret scope is introduced. Session, skill, Git and Drop behavior
continues through the existing engine.

This is a partial implementation of the agreed configuration/memory scope,
not a redefinition of it. Global instructions, project memories, custom roles,
profile documents, per-model preferences and other reviewed settings still
require their own policies and native qualification. A setting that names a
local dependency is not portable just because its value is a string.

## Reviewed policy

| Document | Portable keys |
| --- | --- |
| Codex `config.toml` | `model`, `review_model`, `model_reasoning_effort`, `model_reasoning_summary`, `model_verbosity`, `personality`, `hide_agent_reasoning`, `show_raw_agent_reasoning`, `tui.animations`, `tui.vim_mode_default`, `tui.show_tooltips`, `tui.theme`, `tui.alternate_screen` |
| Claude `settings.json` | `model`, `effortLevel`, `language`, `alwaysThinkingEnabled`, `autoMemoryEnabled`, `verbose`, `editorMode`, `theme` |

Source references fetched on 2026-09-08:
[Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference),
[Claude settings and precedence](https://code.claude.com/docs/en/settings),
[Claude settings reference](https://code.claude.com/docs/en/settings-reference).
These establish native field locations/types; the portability allowlist and
stricter bounds are Statecase's decisions, not vendor endorsements or proof of
native compatibility for every installed version.

The implementation validates enums and primitive types. Model/theme identifiers
are bounded simple identifiers; Claude additionally accepts the `[1m]` model
suffix. Provider ARNs, URLs, filesystem paths, commands, control characters and
unreviewed values in known fields fail closed, with redacted errors. Language
is a bounded human-readable name. Additional valid vendor values require
reviewed policy changes; values are not silently coerced or dropped.

Unknown fields remain local and unchanged. Auth/provider routing, environment
variables, hooks, MCP definitions, trust/approval/sandbox policy, telemetry,
external paths, profile selection, plugin/command activation and managed policy
are not imported. `.claude.json` remains excluded. Local/project/managed
overrides retain native precedence; a synced user preference does not force
the effective value. We cannot identify arbitrary secrets deliberately placed
inside otherwise valid preference values.

## Encrypted representation and merge

Each field is a normal encrypted file entry inside its harness namespace:

`portable-config/v1/user/tui.animations.json`

Its canonical UTF-8 payload is `{"value":false,"version":1}`. The receiver
resolves `user` and the field name using its own registry. No remote native
filename is accepted. Unknown reserved versions/documents/fields, alternate
encodings, duplicate JSON keys, extra fields, wrong types and noncanonical
payloads are rejected. Raw native configuration paths remain excluded on
receipt. At most 128 KiB and one object are admitted per setting.

Per-field paths use the existing three-way merge: disjoint changes merge,
divergent changes to the same preference conflict, and a tombstone removes only
that preference. Deleting every portable field does not delete the native file
or its local secrets. Applied digests cover canonical field bytes, so local-only
credential changes neither publish nor cause semantic conflicts. A local field
deletion against a remote edit is a conflict, not free overwrite consent.

SY-011 fixes a reproduced cross-namespace bug: a no-outgoing-change namespace
must not be marked applied merely because another namespace commits. Otherwise
a second push could delete remote-only state never hydrated by the client.
This applies to supported files and synthetic future adapter paths.

## Native file observation and materialization

1. Read each present selected document through a no-follow, nonblocking
   descriptor. Require a regular, single-link, user-owned file and a real,
   user-owned root, neither writable by group/others. Existing read permissions
   are not widened or changed during observation.
2. Bound native files to 1 MiB and read at most the observed size plus one byte.
   Recheck descriptor/named inode, size, mtime, ctime, permissions, link count
   and root identity. Unsafe/transient input aborts; no partial fields publish.
3. Parse strict JSON or TOML 1.0. Bound AST depth/node count and policy size.
   Reject ambiguity, duplicate keys and scalar/table type collisions.
4. Group incoming fields by native document. Validate both sides and conflicts
   before writing. Patch syntax ranges, preserving unknown lexemes, comments,
   escapes and local-only values, then parse and verify the result. Preview
   performs no materialization or applied-state mutation.
5. Prepare one owner-only replacement per changed document alongside other
   selected files. Guard the full original content hash and file/root identity
   immediately before replacement, including local-only credential changes.
   Preserve workspace callbacks and reject physical target collisions.
6. Use the existing all-or-rollback transaction. A concurrent edit remains
   intact; earlier writes roll back. Advance digests only after successful
   apply. Wipe owned raw buffers and prepared replacement bytes.

These checks defend against unsafe layouts and cooperative races, not an
arbitrary hostile same-UID process. A check-to-rename window remains; native
directory-descriptor atomicity and persistent SIGKILL recovery are not claimed.
Parsed JavaScript strings cannot be reliably zeroized.

Historical in-place restore uses the same field patches and includes the
physical native file once in its local emergency snapshot. That rollback copy
may contain local-only values and must stay owner-protected; it is never the
uploaded setting object. Restored field digests are verified and rekeyed at the
current epoch. Tests inject a failed remote commit and recover the original
local file/applied state, including retained secrets.

## Dependencies and package behavior

Use pinned `jsonc-parser@3.3.1` (MIT) and `toml-eslint-parser@0.10.0` (MIT,
with `eslint-visitor-keys` under Apache-2.0). The newer TOML parser 1.x requires
a higher Node 22 minimum than the declared 22.12 support; upgrade together with
the runtime policy, not incidentally. Both parsers provide AST source ranges.

The JSON parser's explicit ESM entry avoids a reproduced dynamic-require
failure in its default UMD bundle. Clean-prefix package installation exercises
the resulting CLI; the bundle carries byte-matched upstream license files.
This does not replace a complete existing-dependency license audit.

## Compatibility and remaining qualification

Upgrade every participating client before using portable-config namespaces.
Older clients do not understand this layout; SY-011 does not retroactively
protect older binaries. Mixed-version/minimum-client fencing remains a release
gate, alongside native version fixtures, effective settings validation,
exact-package cross-host/live-cloud UAT, authenticated background convergence
and crash/sleep/reboot tests.

No changes were applied to the operator's harness homes or credentials. Current
tests use synthetic roots and reference storage. Parser tests, package startup
and prior native session UAT do not establish complete configuration or memory
portability.

AD-CFG-012 extends the pinned native drivers with effective model/effort checks,
fresh destination sessions and CLI-override precedence. Target configuration is
prepared locally before hydration and is not rewritten afterward. Only those
two preferences are observed in requests: this driver does not qualify the
whole allowlist, UI settings, provider model availability or all precedence
layers. Its execution is recorded separately from the local engine tests.
