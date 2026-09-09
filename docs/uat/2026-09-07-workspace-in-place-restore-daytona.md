# Daytona and Cloudflare Git workspace restore UAT — 2026-09-07

Status: passed

This report qualifies packaged Git-workspace in-place restore against the
deployed Cloudflare service from a disposable Daytona sandbox. It covers the
workspace portion of `BK-009`, `WS-015`, `WS-030`, and `WS-033`.

## Candidate and environment

- CLI package: `@statecase/cli@0.1.0`
- Package SHA-256:
  `c44f63aadc9dbb3d58eb3b5e0a5b3ae8efbe3a2d6215c871b5061f3f11bc438e`
- API: `https://statecase-api.hi-0e6.workers.dev`
- Worker version during the successful run:
  `f9aedc4b-d809-42bb-a2b0-d4fa605be717`
- Restored production Worker version after the run:
  `7ef61695-bf0a-4828-8a8c-8ea57ea6f42b`
- Daytona runtime: Node.js 25.9.0, Git 2.53.0, 1 vCPU, 1 GiB RAM,
  3 GiB disk
- Successful sandbox: `3dd4b769-d11a-4f38-9c19-b8b45878fc22`, private,
  disposable, and deleted after the run

The candidate first passed 387 repository tests, the 90% branch-coverage gate,
lint, typecheck, build, clean-prefix package smoke, 11 real-workerd tests, and
98 targeted workspace/sync/CLI/emergency tests. The sandbox received only the
checksummed npm tarball and the non-secret UAT driver. Passwords, recovery
material, and device tokens were generated inside the sandbox and never
printed.

Production signup remained allowlisted. Each attempt temporarily added one
exact, non-guessable disposable email alongside the owner email; arbitrary
signup remained disabled. The canonical one-address allowlist was redeployed
immediately after each attempt and a rejected signup returned `403` before
cleanup continued.

## Acceptance evidence

The driver created two independently authorized devices, one encrypted vault,
and one logical workspace mapped to two independent clone paths. The source
contained a `main` branch, a historical commit, divergent staged and unstaged
bytes for one tracked path, a staged addition, an untracked file, and a safe
relative symlink. It then advanced `main`, published a different dirty state,
and added a local-only file that had never reached Statecase.

| Check | Result |
| --- | --- |
| In-place dry-run | pass; HEAD, branch ref, raw index digest, status, and files unchanged |
| Explicit consent | pass; mutation required `--in-place --yes` |
| Exact historical identity | pass; historical commit and symbolic `main` restored |
| Independent index/worktree layers | pass; staged bytes and different working bytes restored |
| Resurrection/deletion | pass; historical untracked file and symlink returned; newer and local-only paths disappeared |
| Protected recovery point | pass; protected snapshot ID returned |
| Forward history | pass; restored revision differs from both historical and current revisions |
| Independent observer | pass; second clone pulled the exact commit, symbolic branch, index, worktree, untracked file, and symlink |
| Emergency snapshot | pass; persistent local recovery artifact returned |
| Offline rollback | pass; unreachable API still restored the exact pre-restore HEAD, branch ref, raw index digest, status, files, and symlink |

The successful result was:

```json
{
  "result": "pass",
  "historicalHead": "b911f8d0dbcc1b659a65a0b2dab105a130acda58",
  "currentHead": "18fbc386202b8cf9975ac3701821f789a96b2522",
  "historicalRevisionId": "srev_da30a7f2773a476d8a1ce23f8b9b6bf3",
  "currentRevisionId": "srev_a2a9faa86de249fa89dbe95daa15d384",
  "restoredRevisionId": "srev_7a90b8ae51d8495fb8cf31bfcdfd9ba2",
  "protectedSnapshotId": "snp_3b704dbf98f0429888aaab48839351f6",
  "dryRunNonMutating": true,
  "exactHeadIndexWorktreeRestore": true,
  "currentOnlyRemovalAndHistoricalResurrection": true,
  "independentObserverConverged": true,
  "emergencyRollbackOffline": true
}
```

The reproducible sandbox-side driver is
[`scripts/uat/daytona-workspace-restore.mjs`](../../scripts/uat/daytona-workspace-restore.mjs).

## Defect found by the acceptance test

The first complete-path attempt proved that in-place restore was exact on the
source, but an ordinary clean pull on the independent observer checked out the
captured commit with detached HEAD. That made `headRef` non-convergent and a
later push could have changed the portable workspace identity.

A failing `WS-015` regression was added first. Ordinary workspace apply now
validates the authenticated branch name, captures the previous target-ref
value, checks out the baseline transactionally, and installs the exact
symbolic HEAD after filesystem materialization. Failure restores the previous
target ref and baseline. The 98 focused tests and the full gate passed before
the successful packaged rerun.

## Cleanup

The successful vault's exact R2 prefix contained 14 encrypted objects. A
temporary local maintenance Worker, hard-limited to that exact vault prefix,
deleted all 14 and a second inventory returned zero. D1 cleanup removed the
exact disposable user's sessions, devices, memberships, audit events, vault,
Statecase account, and Better Auth rows in foreign-key-safe order; the final
query returned zero users, vaults, devices, and audit events. The successful
sandbox was deleted and reported desired state `destroyed`.

Two pre-success diagnostic attempts were also isolated and fully cleaned: their
exact R2 prefixes returned zero after deleting 7 and 14 objects respectively,
their exact D1 identities returned zero, and both sandboxes were deleted. No
unrelated Daytona sandbox, D1 row, R2 prefix, bucket, database, Durable Object
namespace, or deployed Worker binding was modified.

## Remaining boundary

This qualifies exact Git workspace recovery on the tested Linux x64/Daytona
profile and live Cloudflare stack. Initialized submodule worktrees remain
explicitly fail-closed pending a transactional hydration design. Real-version
Codex/Claude recovery and native systemd/launchd lifecycle UAT remain separate
release gates.
