# Packaged Claude continuity across independent Daytona peers and live Cloudflare

Date: 2026-09-08
Status: foreground native/live-cloud round trip passed for the recorded package;
not a full production release qualification
Test IDs: UAT-03 subset, AD-CL-002/006, RT-001/003, WS-034; SK-001 defect found

## Candidate and topology

- Product commit: `8f3312889f513710eaff49d9774f5e9b3ffd1365`.
- Clean `@statecase/cli@0.1.0` tarball installed independently on each peer.
  Tarball SHA-256:
  `b4ea1882bbcc4f485f1685bc7790296f93125b8095578ef330176b0b0c26c855`.
- Actual Claude Code `2.1.263 (Claude Code)` and Node `22.22.3`, pinned on both.
- Source sandbox: `8255dc7a-a4a7-4835-b11f-5179a7a963ad`.
- Destination sandbox: `9be6d2d7-cbfe-4403-aa05-11c3505dd99d`.
- Both created independently from `daytona-small`; distinct filesystems,
  homes, native project paths, Statecase profiles, and device authorizations.
  No linked sandbox or shared volume was requested. Physical host placement is
  not asserted: Daytona controls the underlying infrastructure.
- Both Git baselines were created from identical synthetic inputs, author,
  timestamps and initial branch, yielding commit
  `05b8d36d95e9aa5f17424dbd75f1710a8ed97217`.
- Live service: `https://statecase-api.hi-0e6.workers.dev`, D1 schema through 0005.
  Original Worker: `dd6894cf-d042-425b-9e3e-7906b75ede04`.
  Temporary allowlist Worker: `13ba1cc3-0018-4a66-9ed9-6d3a127e8446`.
  Restored canonical-allowlist Worker: `3460deaa-bf3c-4244-bc13-9f0979b521b3`.
- Peer script imports only Node built-ins. Statecase is invoked exclusively
  through the installed CLI and its installed transparent Claude shim.
- Initial peer-script SHA-256 (initialization and source run):
  `26792f5917be0189e2e5355b0bd2d8e2dcef45e8c50bd293b8c8d313368a39fc`.
  Final peer-script SHA-256 (hydration/resume/return):
  `1faf47e2c068aaaccfa1864d38283b352400b3a2692e8d9efb11530a2b6e1e57`.
  The difference adds metadata-only inspection and correctly represents an
  absent native root during preview; it does not change the installed product.

The model provider remains a deterministic loopback Messages fixture on each
peer. Real Claude executes Read/Edit/Write, persists sessions and resumes them;
no hosted inference or model-provider credentials are used. Only the encrypted
recovery kit and opaque session/vault identifiers cross the orchestration
channel. No native transcript, workspace overlay, profile or raw vault key is
copied between peers outside Statecase.

## Executed acceptance sequence

1. A unique allowlisted account receives two independent RFC 8628 device
   authorizations. The canonical signup restriction is restored before native
   work; a new signup attempt for the fixture address returns
   `403 SIGNUP_DISABLED`.
2. Source CLI logs in, creates the vault and recovery kit, attaches the Git
   workspace, and installs a transparent shim resolving to the real Claude
   executable. Target separately logs in and joins using the encrypted kit.
3. Source launches the installed `claude` shim. Native Read verifies tracked
   input, Read/Edit changes a tracked artifact, and Write creates an untracked
   note. The shim's final flush publishes the session and overlay to Cloudflare.
   No manual push substitutes for that flush.
4. Target reads the remote dependency report. All three file paths are resolved.
   Strict preview preserves local config bytes, baseline file bytes, absence of
   the note, and absence of the not-yet-created native root.
5. Strict hydration creates the session at the target's different Claude project
   path and restores edited/untracked bytes onto the exact Git baseline.
6. The target shim runs `claude --resume` with original UUID
   `f9ea8327-5edf-4419-afa5-0cef94ae99b2`. The new prompt does not repeat the
   source marker. The provider verifies the original user prompt and original
   native Read output in Claude's restored model-visible history.
7. Real target Read/Edit appends the continuation. Its shim's final flush
   advances the cloud Session Capsule; no manual push is called.
8. Source is verified unchanged before explicit pull. Source CLI then receives
   continued file bytes and native session history at its original native path,
   retaining a single session binding. No Git reset, forced historical restore,
   direct transcript copy, or local index injection is used.

Every executed phase returned `pass`. The initial source capsule was
`cap_7cc5a9070bc14c0c844fb4d472e1d8cc`; target continuation advanced it to
`cap_226d06228dd2444cbdf87d10f9910d78`. A bounded scan of all 11 fixture R2
objects found none of the synthetic transcript/file canaries in plaintext.
Canary absence complements the crypto tests; alone it is not a proof of E2EE.

## Failure, diagnosis, and separate installer fix

The first target hydration attempt stopped in the test's pre-preview directory
scan, not inside product hydration. Read-only inspection confirmed zero applied
namespaces, zero native bindings, unchanged baseline bytes, and an absent
configured Claude root. A fresh root is valid before the first native launch;
the driver now records and checks absence rather than assuming it exists.

Inspection also found a real SK-001 bug: setup installed the canonical skill in
the default `.claude` directory even with `CLAUDE_CONFIG_DIR` pointing elsewhere.
Two failing-first unit regressions reproduce the root-resolution mismatch.
Install, verify and uninstall now share the Claude adapter's root resolver.
An isolated-HOME lifecycle test proves no unused default directory is created,
and the clean-package smoke tests real setup/verify/uninstall with an overridden
root and an allowlisted environment.

That installer correction is a **later local candidate**, not included in the
tarball used for the successful cross-peer resume. Its complete local check
passed 503 tests in 35 files, 90.39% global branch coverage, lint, typecheck,
build and the strengthened clean-prefix package smoke. CI and a subsequent
fresh live run must qualify that exact candidate; this report does not silently
upgrade the earlier package's evidence. Workspace branch coverage remains
88.88%, below its critical-code target.

## Cleanup

- Exact fixture account: `K92USIwMqxnSkVZPybyh4sfT8waLQ6kv`.
- Exact fixture vault: `vlt_d1d62651a6484dee91e6ebe6d870ff0a`.
- A loopback-only maintenance worker resolved that account by its unique
  synthetic email and required exactly its one vault before touching R2.
- All 11 objects under that exact vault prefix were removed. Subsequent prefix
  listing returned zero objects with `truncated: false`.
- Foreign-key-ordered exact-target D1 cleanup removed the fixture account,
  devices, memberships, auth sessions and associated metadata. A separate
  read-only verification query and maintenance lookup establish removal.
- Both owned sandbox IDs were deleted. Filtered inventory then showed only the
  pre-existing unrelated sandbox, which was never changed.
- Native processes were bounded and only their owned process groups terminated.
  Deleting the disposable sandboxes removes generated credentials, sessions,
  workspaces and test-installed binaries; those files are not recoverable.
- Opaque fixture-vault Durable Object metadata was not explicitly purged. No
  claim of deleting every remote DO record is made.

A separate read-only D1 command returned zero users, vaults, devices, auth
sessions, key envelopes and audit events for the fixture identities. The
maintenance lookup returned `accountFound: false`. Local fixture tokens,
password/passphrase state and the encrypted recovery kit were removed after
verification; only non-secret evidence/orchestration artifacts remain. The
owned maintenance listener exited after termination. The live health endpoint
remains `status: ok`.

## Reproduction and scope boundaries

The operator provisions two disposable peers, installs the same hashed package
and pinned harness, and supplies a private `input.json` under each
`statecase-crosshost-<24-hex-run-id>-a|b` fixture directory. Required fields are
`runId`, `role`, `apiUrl`, absolute installed `cli` and `claude` paths, device
`token`, and `recoveryPassphrase`; target additionally receives `vaultId`, the
encrypted `recovery.json`, and then `sessionId`. Do not print or commit inputs.
With `STATECASE_UAT_CONFIRM=create-and-modify-remote-state`, invoke the peer
script with `init`, source `source`, target `hydrate`, target `resume`, then
source `return`. `inspect` is non-mutating fixture diagnosis only. The external
operator owns narrowly scoped signup provisioning, guaranteed allowlist
rollback, and verified exact-target cloud/sandbox cleanup. This is not a
credential-free CI job.

This qualifies the recorded **Claude foreground shim/live-cloud** path across
independent sandbox instances. It does not qualify hosted model inference,
Codex on this combined topology, native daemon convergence, sleep/reboot,
interactive listing or `--continue`, other harness versions, missing-baseline
acquisition, initialized submodules, historical session rollback, complete
opaque-tool read observation, independent security review, or the later
installer fix on a fresh live pair. Full production readiness remains open.
