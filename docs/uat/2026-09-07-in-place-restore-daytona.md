# Daytona and Cloudflare in-place restore UAT — 2026-09-07

Status: passed

This report qualifies the full-key, two-way Drop in-place restore path against
the deployed Cloudflare service from a disposable Daytona sandbox. It covers
`BK-006`, `BK-009`, and `BK-011`; stopped native harness lifecycle remains
covered by automated process/barrier tests rather than this Drop fixture.

## Candidate and environment

- Candidate commit: `fc46a02`
- CLI package: `@statecase/cli@0.1.0`
- Package SHA-256:
  `8e780c156a20c528620dadc1feb2a7cc99ce4d65571423bf5489f4a0541af19a`
- API: `https://statecase-api.hi-0e6.workers.dev`
- Worker version: `e9b7158e-b05a-441a-a807-412d40661858`
- Daytona runtime: Node.js 22.23.2, 1 vCPU, 1 GiB RAM, 3 GiB disk
- Successful sandbox: `692f5d6c-8b45-4af7-93fb-41d5765cc269`, ephemeral,
  60-minute TTL

Before the remote run, the candidate passed 372 repository tests, the 90%
coverage gate, lint, typecheck, build, clean-prefix package smoke, real workerd
tests, and the isolated Docker gate. The sandbox received only the checksummed
npm tarball and the non-secret UAT driver. Passwords, recovery material, and
device tokens were generated inside the sandbox and never printed.

## Acceptance evidence

The driver created two independently authorized devices and one arbitrary Drop
mapped to different native paths. It then created a historical revision with a
nested file, advanced the remote state with replacement, addition, and
deletions, and added an unpublished local-only file.

| Check | Result |
| --- | --- |
| In-place dry-run | pass; target and remote head unchanged |
| Explicit consent | pass; mutation used `--in-place --yes` |
| Historical replacement | pass; exact historical bytes restored |
| Resurrection/deletion | pass; tombstoned files returned and newer/local-only files disappeared |
| Protected recovery point | pass; a protected snapshot ID was returned |
| Forward history | pass; restored revision differs from historical and current revisions |
| Independent observer | pass; second device pulled the restored state exactly |
| Emergency snapshot | pass; persistent path returned |
| Offline emergency rollback | pass; pre-restore current and unpublished bytes returned with an unreachable API URL |

The successful result was:

```json
{
  "result": "pass",
  "historicalRevisionId": "srev_ca14c9dac4924ef19009486e82153614",
  "currentRevisionId": "srev_dd0b63cec1024074864771575a537956",
  "restoredRevisionId": "srev_a26714105925496284321816f70eef57",
  "protectedSnapshotCreated": true,
  "emergencyRollbackOffline": true,
  "observerConverged": true
}
```

The reproducible sandbox-side driver is
[`scripts/uat/daytona-in-place-restore.mjs`](../../scripts/uat/daytona-in-place-restore.mjs).

## Transient and rerun policy

An earlier clean run received exit `7` on its first push while Cloudflare also
returned a transient account-authorization error to an independent Wrangler D1
request. Health remained `200`; no R2 object had been uploaded. The runner
deleted that sandbox and the operator removed its exact disposable D1 rows.
The test was rerun from a clean identity without weakening or retrying an
acceptance assertion, and the entire flow passed.

## Cleanup

The Daytona SDK deleted the successful sandbox and awaited destruction. A
temporary, non-deployed maintenance Worker was hard-limited to the exact UAT
vault prefix; it deleted 8 encrypted R2 objects and verified zero remaining.
D1 cleanup removed the exact disposable account, sessions, devices, audit
events, membership, and vault in foreign-key-safe order, then verified zero
matching users and vaults. Two unclaimed device codes from an earlier failed
enrollment attempt were deleted by their exact one-second expiry interval. No
unrelated Daytona sandbox, D1 row, R2 prefix, or deployed Worker was modified.

## Remaining boundary

This qualifies Drop restore from the tested Linux x64/Daytona profile and the
live Cloudflare stack. Native Codex/Claude exclusion is covered by automated
process, lock, malformed-marker, and rollback tests; real-version harness UAT
is still required for the public harness recovery claim. Workspace in-place
restore remains unsupported until the Git transaction path is implemented and
qualified.
