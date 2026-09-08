# Native effective preferences and mutex lifetime qualification

Date: 2026-09-08
Candidate: `239a21b4b8991bd82097790863944d9777466f07`
Test IDs: AD-CFG-012, AD-CX-007, WS-022, RT-016, AU-013; UAT-02 subset
Status: selected native preferences pass; broader release gates remain open

## Executed native evidence

On the exact candidate above, the following jobs passed in
[CI 34196810044](https://github.com/alemicali/statecase/actions/runs/34196810044):

- [Codex native qualification](https://github.com/alemicali/statecase/actions/runs/34196810044/job/101966252367):
  `codex-cli 0.153.4`, Node `v24.20.0`.
- [Claude native qualification](https://github.com/alemicali/statecase/actions/runs/34196810044/job/101966252373):
  `2.1.263 (Claude Code)`, Node `v24.20.0`.

The complete run is terminal **success: all nine jobs passed**, including
quality, Node 22/24 compatibility, authenticated background synchronization,
Linux/macOS credential packaging and native macOS service lifecycle.

Each scenario uses a real pinned harness binary and the real encrypted sync
engine, with two synthetic device homes/workspaces on one disposable runner
VM, an in-memory reference transport and deterministic loopback inference.
No operator harness directories, cloud buckets, keychains or transcripts are
used. Provider bodies and native raw diagnostics are not logged.

Both native results assert:

1. The original session UUID and its history survive transfer and native resume.
2. Native file tools read transferred workspace bytes and write a continuation;
   publishing and returning to the source preserves the continuation.
3. Hydration preview is non-mutating; project paths are remapped per device.
4. A **fresh destination session**, not a resumed session retaining old options,
   sends the synchronized model and low effort in its actual provider request.
   Codex uses `gpt-5.6-terra`; Claude uses `claude-sonnet-4-6`.
5. A second fresh destination invocation selects high effort via a CLI override.
6. The native configuration remains byte-identical around both preference
   invocations. Target-local provider/env/trust state is preserved; source-local
   provider/trust/env state is not imported.

Codex checks `reasoning.effort`; Claude checks `output_config.effort`.
Test-only negative controls reject missing/wrong model or effort and unsupported
harnesses. Neither scenario supplies a model CLI override or rewrites the
target's preferences after hydration. Config-difference diagnostics expose
only fixed field categories, synthetic source/target/other identity classes
and allowlisted trust enums, never arbitrary keys, values or paths.

## False-positive alternatives and fixture corrections

The original baseline scenarios could mask a broken transfer: Codex rewrote
target config after hydration, and Claude selected its model through a CLI
flag. AD-CFG-012 removed those alternatives and initially failed.

- Claude's restricted mode intentionally ignores ordinary user settings. The
  isolated fixture uses `--setting-sources user`, retaining explicit
  Read/Write/Edit tools, empty strict MCP configuration, no Chrome and a fresh
  private home. This affects only the disposable qualification environment.
- The Responses simulator now emits complete text content/delta/done events.
  This corrects its protocol shape but did not fix the config assertion by itself.
- Codex process cwd is explicitly the corresponding synthetic device workspace,
  including startup before `-C` handling. This improves isolation but did not
  by itself resolve the config assertion.
- [Run 34196530761](https://github.com/alemicali/statecase/actions/runs/34196530761),
  commit `ee7fb92`, identified exactly one semantic change: the first new target
  session added its own previously absent `trust_level = "trusted"` entry.
  Native resume had not initialized it. No other project properties or
  top-level config values changed.
- Each disposable device now approves only its own synthetic project **during
  setup, before transfer**. Byte equality is still required; the source project
  path/trust must not cross into target config. This establishes preservation
  of configured local authority, not a promise that Codex never performs its
  own first-use initialization. Statecase does not set or synchronize trust.

Official references used to distinguish preference precedence, trust metadata
and protocol behavior:
[Codex config](https://learn.chatgpt.com/docs/config-file/config-reference),
[Responses streaming](https://developers.openai.com/api/reference/resources/responses/streaming-events),
[Claude CLI](https://code.claude.com/docs/en/cli-usage).
Observed first-use behavior above is execution evidence for the pinned binary,
not a vendor guarantee for all versions.

## Mutex correction and local verification

CI `34195140316` failed the publication-boundary mutex assertion in both
Node 24 and quality. Forcing garbage collection in the suspended native child
reproduced loss of exclusion at both recovery/publication checkpoints before
the fix. The native database destructor closes SQLite handles when collected;
an unresolved async continuation is not a durable ownership root.

Commit `1561dd8` strongly retains acquired mutexes until explicit release or
process death. The regressions now force GC before checking live-owner denial,
then SIGKILL that exact owner and require successful recovery. Normal held and
released ownership also runs GC; eight restart contenders still yield exactly
one winner. Abandoned ownership intentionally fails closed until process exit.
See [ADR-0022](../adr/0022-kernel-backed-profile-mutex.md).

The exact candidate's local `npm run check` passed **671 tests / 48 files**,
lint, type checking, build and clean-installed package checks. Global branch
coverage is **91.12% (3688/4047)**; the modified mutex is **95.65%** and runtime
is **95.45%**. The separate local Worker suite passed 12 tests after the mutex
fix; its deliberately injected ambiguous-rotation exception is expected.

## Boundaries: not production readiness

This qualifies **model and effort**, not the effective behavior of every
allowlisted preference, every native override layer, provider/model availability,
TUI pickers, all harness versions, or arbitrary project instructions/memory.
Both native homes are on one VM. Inference is simulated; the remote backend
is a reference implementation. This is not exact-package live-Cloudflare
cross-host/background/native qualification.

Instructions/memory implementation, mixed-client fencing, workspace persistent
crash recovery, broader version/OS/reboot testing, independent security review
and the other readiness gates remain required. These passes do not supersede
or waive them.
