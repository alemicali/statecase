# Daytona Git-baseline acquisition UAT — 2026-09-07

Status: passed

This report qualifies automatic Git-baseline acquisition using the packaged
Statecase CLI, a real Daytona sandbox, system Git, and the deployed Cloudflare
service. The same candidate had already passed the repository, workerd, and
Docker gates before this run.

## Candidate and environment

- CLI package: `@statecase/cli@0.1.0`
- Package SHA-256:
  `1f876e2ab32dbf9fc83969eafda8f7ccc5e44e198a4cc9d4b6149f6f7ca144e9`
- API: `https://statecase-api.hi-0e6.workers.dev`
- Worker version: `1957598c-cf58-42e6-88a9-9ebc95d9babf`
- Daytona runtime: Node.js 25.9.0 and Git 2.53.0
- Isolation: ephemeral sandbox, clean npm prefix, 30-minute TTL

The sandbox received only the candidate tarball and the UAT driver. Daytona
credentials, Cloudflare credentials, local agent homes, and Git credentials
were not copied into it. Statecase account and recovery secrets were generated
inside the sandbox and never printed.

## Acceptance evidence

The driver created two independently authorized Statecase devices and an
encrypted vault on the live Worker. It then:

1. captured a dirty workspace at Git baseline A;
2. advanced the device-local Git remote to baseline B;
3. created a depth-one clone containing B but not A;
4. attached that clone with `--git-fetch ask` and verified exit code `5`,
   `BASELINE_UNAVAILABLE`, unchanged HEAD, and continued absence of A;
5. reattached with explicit `--git-fetch auto` and pulled again;
6. verified that system Git obtained A, HEAD became the exact captured commit,
   and both the modified tracked file and untracked file matched byte-for-byte.

The remote driver reported:

```json
{
  "result": "pass",
  "deviceAuthorization": "single-use verified",
  "devices": 2,
  "vaultCreated": true,
  "encryptedRoundTrips": 2,
  "deletionPropagation": true,
  "conflictDetectedWithExitCode": 5,
  "conflictResolvedWithProtectedSnapshot": true,
  "namedSnapshotCreated": true,
  "shallowGitBaselineAcquisition": "ask-preserved-auto-restored",
  "codexAndClaudeHomesRemainIsolated": true
}
```

The repeatable driver is
[`scripts/uat/daytona-product.mjs`](../../scripts/uat/daytona-product.mjs).

## Cleanup

The ephemeral Daytona sandbox was deleted and awaited to the destroyed state.
The 21 R2 objects under the exact disposable vault prefix were selected and
deleted; the filtered prefix then contained zero rows. Account-scoped D1 rows
were removed in foreign-key-safe order. A final read-only query returned zero
users, Statecase accounts, vaults, devices, and audit events for the UAT
identity. As in the earlier product UAT, the unguessable Durable Object state is
no longer reachable after control-plane cleanup; general retention collection
remains a separate release gate.
