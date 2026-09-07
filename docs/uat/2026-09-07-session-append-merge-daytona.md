# Daytona same-session append merge UAT — 2026-09-07

Status: passed

This report qualifies bounded, deterministic same-session JSONL append merge
and device-local native-path continuity using the packaged Statecase CLI, four
logical devices in a real disposable Daytona sandbox, and the deployed
Cloudflare service.

## Candidate and environment

- Candidate commit: `9545f07`
- CLI package: `@statecase/cli@0.1.0`
- Package SHA-256:
  `bcbaa3f5ada20a275f60cd1c984287ea2acc1865948ddd32f692555885ec385b`
- API: `https://statecase-api.hi-0e6.workers.dev`
- Worker version: `1957598c-cf58-42e6-88a9-9ebc95d9babf`
- Daytona runtime: Node.js 25.9.0, Git 2.53.0, Git LFS 3.6.1
- Sandbox: `6d8297e1-7cd8-49e1-9238-9b628c1fa70c`, ephemeral,
  30-minute TTL

Before the run, the candidate passed 298 repository tests with 90.86% aggregate
branch coverage, 10 isolated Worker tests, typecheck, lint, build, package-smoke,
and canonical skill validation. GitHub checks passed on Node.js 22 and 24 plus
the full quality job.

The sandbox received only the checksummed npm tarball and the non-secret UAT
driver. It did not receive local Codex/Claude homes, Daytona or Cloudflare
credentials, Git credentials, or local Statecase credentials. Statecase account
passwords, recovery material, and device tokens were generated inside the
sandbox and never printed. The tarball digest was verified before installation.

## Acceptance evidence

The driver retained the complete product UAT: independently authorized
devices, encrypted binary/UTF-8/hidden-file Drop round trips, deletion
propagation, stale-base conflict exit code `5`, protected conflict resolution,
named snapshots, exact shallow Git-baseline acquisition, and verified Git LFS
acquisition.

For same-session continuity it additionally:

1. enrolled a fourth independent device and mapped the same metadata-only
   workspace ID to different absolute paths on devices A and D;
2. published one Codex session from a dated native path on A and pulled it to
   D's canonical fresh-device path;
3. appended two ordered records independently on both devices;
4. rewrote the accepted prefix on D, verified push exit code `5`, and proved
   that the rejected update did not advance the remote head;
5. restored the valid prefix and published the concurrent merge;
6. verified the Session Capsule dependency report retained both branch-specific
   file references;
7. pulled on D and on the originating device A, proving that all four append
   IDs occurred exactly once and each branch's record order was preserved;
8. proved A's original dated session file was updated and that no divergent
   `sessions/statecase/...` copy was created there.

The final remote result was:

```json
{
  "result": "pass",
  "apiUrl": "https://statecase-api.hi-0e6.workers.dev",
  "deviceAuthorization": "single-use verified",
  "devices": 4,
  "vaultCreated": true,
  "encryptedRoundTrips": 2,
  "deletionPropagation": true,
  "conflictDetectedWithExitCode": 5,
  "conflictResolvedWithProtectedSnapshot": true,
  "namedSnapshotCreated": true,
  "shallowGitBaselineAcquisition": "ask-preserved-auto-restored",
  "gitLfsAcquisition": "ask-preserved-auto-verified",
  "sameSessionAppendMerge": "rewrite-preserved-branches-converged-dependencies-retained",
  "codexAndClaudeHomesRemainIsolated": true
}
```

The reproducible driver is
[`scripts/uat/daytona-product.mjs`](../../scripts/uat/daytona-product.mjs).

## Finding and correction

An earlier diagnostic run exposed a real product defect rather than a test
fixture issue: the merged pull on the originating device wrote the portable
session to the canonical fallback and left the original dated Codex file stale.
The accepted fix adds a local-only binding from remote session identity to the
validated native relative path. Push, pull, hydration, deletion, dry-run,
supervised flush, traversal, and collision regressions now cover that binding.
The successful candidate reran the unweakened cross-machine assertion.

## Cleanup

The Daytona SDK deleted the sandbox in the runner's `finally` block; a separate
Daytona list returned zero remaining sandboxes. R2 cleanup selected only the two
folders under the exact disposable vault prefix
`v1/vaults/vlt_1945283b23934d228e22cb9ce30d127e/`; a refreshed search returned
zero rows and no matching text. D1 rows for the disposable account were removed
in foreign-key-safe order. A final read-only query returned zero Better Auth
users/accounts/sessions, Statecase accounts, devices, vaults, audit events,
device sessions, and capability grants for that identity. No unrelated R2
prefix, D1 row, Cloudflare resource, or sandbox was modified.

## Remaining boundary

This UAT qualifies the currently bounded merge profile. It does not satisfy the
separate constant-memory, multi-gigabyte streaming requirement; that remains a
release gate.
