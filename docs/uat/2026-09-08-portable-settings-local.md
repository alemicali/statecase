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
