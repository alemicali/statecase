# Daytona Git LFS acquisition UAT — 2026-09-07

Status: passed

This report qualifies transparent Git LFS object acquisition using the packaged
Statecase CLI, a real disposable Daytona sandbox, system Git LFS, and the
deployed Cloudflare service. Repository, workerd, package-smoke, and hardened
Docker gates passed before this run.

## Candidate and environment

- Candidate commit: `5877b0f`
- CLI package: `@statecase/cli@0.1.0`
- Package SHA-256:
  `669fae6926b7dbbdb798b49e61993db9877c99acfde389e1f2b6294c1cdf5ec1`
- API: `https://statecase-api.hi-0e6.workers.dev`
- Worker version: `1957598c-cf58-42e6-88a9-9ebc95d9babf`
- Daytona runtime: Node.js 25.9.0, Git 2.53.0, Git LFS 3.6.1
- Sandbox: `693a6dbe-dc0f-4fcc-b463-9a5447391b06`, ephemeral,
  30-minute TTL

The sandbox received only the npm tarball and the non-secret UAT driver. It did
not receive Daytona, Cloudflare, Git, Codex, Claude, or local agent-home
credentials. Statecase account passwords and the recovery passphrase were
generated inside the sandbox and were never printed. The tarball SHA-256 was
verified again after transfer and before installation.

## Acceptance evidence

The driver retained the complete product UAT: three independently authorized
devices, encrypted Drop round trips across different paths, deletion
propagation, stale-writer conflict detection with exit code `5`, protected
conflict resolution, named snapshots, and exact shallow Git-baseline recovery.

For Git LFS it additionally:

1. created a real local `file://` bare remote using system Git LFS;
2. committed and pushed a random 96 KiB LFS object;
3. captured that clean baseline through Statecase;
4. cloned with smudge disabled so the destination contained only the canonical
   pointer and no local LFS object;
5. attached with `--git-fetch ask`, verified exit code `5` and
   `GIT_LFS_CONTENT_UNAVAILABLE`, and proved the pointer remained byte-for-byte
   unchanged;
6. reattached with explicit `--git-fetch auto` and pulled again;
7. proved that system Git LFS fetched the pinned baseline through the existing
   origin and that the restored bytes exactly matched the original random
   object.

The final remote result was:

```json
{
  "result": "pass",
  "deviceAuthorization": "single-use verified",
  "devices": 3,
  "vaultCreated": true,
  "encryptedRoundTrips": 2,
  "deletionPropagation": true,
  "conflictDetectedWithExitCode": 5,
  "conflictResolvedWithProtectedSnapshot": true,
  "namedSnapshotCreated": true,
  "shallowGitBaselineAcquisition": "ask-preserved-auto-restored",
  "gitLfsAcquisition": "ask-preserved-auto-verified",
  "codexAndClaudeHomesRemainIsolated": true
}
```

The reproducible remote-side driver is
[`scripts/uat/daytona-product.mjs`](../../scripts/uat/daytona-product.mjs).

## Findings

The first real pass exposed cross-scenario state in the UAT driver: publishing
the LFS workspace also republished a previously advanced Git workspace, so the
second logical machine correctly stopped on a local/remote conflict before it
could evaluate LFS. The final driver uses a third independently enrolled device
for the LFS destination, keeping the two workspace assertions isolated without
weakening conflict detection.

## Cleanup

The successful sandbox and every provisioning-only predecessor were deleted and
awaited to the destroyed state. A label-filtered Daytona query returned no
remaining Statecase Git-LFS UAT sandbox. D1 cleanup removed the disposable
identity in foreign-key-safe order; a final query returned zero users,
Statecase accounts, vaults, devices, and audit events for the UAT identity.

R2 cleanup was scoped to the three exact disposable vault prefixes created by
the diagnostic and successful runs. Browser-side prefix verification guarded
each recursive delete, and a final independent search returned zero folders for
all three prefixes. No other sandbox, database row, bucket, or R2 prefix was
modified.
