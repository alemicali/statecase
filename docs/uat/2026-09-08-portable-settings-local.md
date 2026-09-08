# Portable settings: local implementation qualification

Date: 2026-09-08
Status: local automated qualification passed; native/cross-host qualification open
Related: ADR-0023, AD-CFG-001 through AD-CFG-011, SY-011

## Executed evidence

- `npm run check`: passed on Node 22.22.3. Lint, typecheck, **663 tests across
  46 files**, coverage, standalone CLI build and clean-prefix package smoke.
- Branch coverage: **91.12% overall (3688/4047)**; settings file observation
  **95.74%**, settings merge/materialization planner **91.66%**, JSON/TOML codec
  **95.03%**, canonical transport **91.66%**, each harness preference policy
  **100%**. Existing broader sync/workspace module coverage gaps are not waived.
- `npm run cloud:test`: **12 tests passed** against isolated workerd bindings.
  The injected unavailable-rotation outcome emits its expected exception during
  the passing fault test. This run does not invoke the deployed Worker.
- `npm audit --omit=dev --audit-level=high --package-lock-only`: zero findings.
- `git diff --check`: passed.

The package smoke initially failed at startup because the JSON parser's UMD
entry hid a dynamic require from the ESM bundler. Switching to the pinned
parser's explicit ESM entry fixed the reproduced failure. The final clean
installation also compares the bundled parser license files byte-for-byte
against the installed source dependencies.

## Scenarios actually covered

The pure codec suite covers exact filtering, range edits and native syntax
ambiguity. It retains comments, unknown fields, large unknown numeric lexemes,
escaped values and BOM, with resource limits and 100 randomized round trips.
Canonical transport and harness policies are tested independently from native
file handling.

Two synthetic Codex roots and two synthetic Claude roots use the real encrypted
SyncEngine against reference storage. The tests demonstrate first transfer,
non-mutating preview, remote field decryption with no raw native config file,
secret-only no-op, disjoint preference convergence, divergent edit/delete
conflicts, single-field deletion and deletion of every portable field while
retaining the native file's local secret. Applied digests represent fields,
not machine-specific full documents.

Descriptor tests reject symlinks, hard links, FIFO/directory targets, unsafe
writable files/roots and oversized content; mutations during reading or after
planning are detected. An engine-level fault rotates a local-only value after
staging, aborts the settings replacement, and verifies rollback of an earlier
skill write and unchanged applied markers. Retry succeeds while retaining the
new local-only value.

Historical restore runs at key epochs one and two. It restores old preferences,
removes later preferences, preserves current local secrets and creates one
physical config recovery target. Injected remote commit failure restores the
prior native file and applied markers without advancing the remote head.

SY-011 was failing-first: an unrelated Drop commit incorrectly acknowledged
unhydrated remote harness entries, causing a later push to mutate that head.
The fix retains the old applied marker; later pull hydrates recognized skills
or rejects unsupported future paths without deleting them.

## Boundaries and remaining gates

No operator harness directory, keychain, backup, live bucket or account was
used. No cloud resource or sandbox was provisioned for this qualification.
Reference storage and package startup are not evidence of exact-package
cross-host/native-settings correctness.

Required follow-on evidence includes actual Codex/Claude effective settings,
version/precedence compatibility, scoped ephemeral permissions, mixed-client
fencing, background/native convergence, cross-host/live Cloudflare execution,
process death during replacement, reboot/sleep, and independent security review.
Instructions, memories and additional configuration documents remain missing
implementation, not merely unexecuted tests. The product is not production-ready.

## Existing CI regression baseline

The feature commit `53f5db32b29fb9660c1ccd812ee57ca53eb91206` passed all nine
jobs in [CI run 34193418225](https://github.com/alemicali/statecase/actions/runs/34193418225):
quality, Node 22/24 compatibility, background sync, Linux/macOS credentials,
launchd and the existing native Codex/Claude session scenarios. Those original
native scenarios did not assert effective synced preferences: Codex rewrote
its target fixture config and Claude selected its model through a CLI flag.
AD-CFG-012 removes those alternative explanations and requires new evidence.

The first strengthened native run, commit `4944c6f` / CI `34194327941`, failed:
Claude did not select the configured model; Codex passed resume but failed in
the fresh-preferences phase. Claude's `--restricted` mode intentionally ignores
user settings, as documented in the
[official CLI reference](https://code.claude.com/docs/en/cli-usage). The test therefore
uses `--setting-sources user` only inside its already-required disposable host,
retaining explicit Read/Write/Edit tools, no browser and empty MCP configuration.
The operator's harness configuration and permissions are not changed. Codex's
probe compares file stability around each fresh invocation and reports only
bounded diagnostic categories; subsequent execution remains required.
