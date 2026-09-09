# Daytona and Cloudflare product UAT — 2026-09-06

Status: passed

This report records a real, credential-isolated acceptance run of the packaged
Statecase CLI against the deployed Cloudflare service. It was not a mock-server
or in-process Worker test.

## Candidate and environment

- CLI package: `@statecase/cli@0.1.0`
- Package SHA-256:
  `6350b01ef61519601049221a23b2362baf0d8a6628dc1e29b9c87a0ef6973d8d`
- API: `https://statecase-api.hi-0e6.workers.dev`
- Worker version tested: `1957598c-cf58-42e6-88a9-9ebc95d9babf`
- D1: `statecase` (`e92ffa3c-dff8-4740-afe2-f7e84081b2b2`)
- R2: `statecase-vaults`
- Sandbox: Daytona Debian 13, 1 vCPU, 1 GiB RAM, 3 GiB disk, US target
- Node.js: 25.9.0
- Codex CLI: 0.128.0
- Claude Code: 2.1.19

The sandbox received only the npm tarball and the non-secret UAT driver. No
GitHub credential, harness credential, Cloudflare credential, long-lived
Statecase credential, or local agent home was copied into it. The test account
password and recovery passphrase were randomly generated inside the sandbox,
kept in process memory, and never printed.

## Acceptance evidence

| Check | Result |
| --- | --- |
| Tarball survives transfer byte-for-byte | pass; local and remote SHA-256 match |
| Clean-prefix npm installation | pass; three runtime packages installed |
| Default CLI endpoint | pass; points to `statecase-api` |
| Agent-native skill installation | pass; `SKILL.md` and agent metadata materialized |
| Codex mapping respects `CODEX_HOME` | pass |
| Claude mapping respects `CLAUDE_CONFIG_DIR` | pass |
| Transparent Codex shim | pass; real Codex started, output and exit 0 preserved |
| Transparent Claude shim | pass; real Claude started, output and exit 0 preserved |
| Offline harness policy | pass; preflight/final work queued without blocking the harness |
| RFC 8628-style device flow | pass; two independent device sessions approved |
| Device code replay | pass; second exchange rejected with HTTP 400 |
| Two logical machines | pass; two independent Statecase homes and device IDs |
| Encrypted vault creation and recovery join | pass |
| Arbitrary Drop mapping across different paths | pass |
| Hidden, nested UTF-8, and binary files | pass; exact byte comparison after pull |
| Bidirectional updates | pass; two encrypted cloud round trips |
| Deletion propagation | pass |
| Concurrent stale-base detection | pass; CLI exit code 5 |
| Explicit local conflict resolution | pass |
| Pre-resolution remote protection | pass; protected snapshot created |
| Named snapshot creation/listing | pass |
| `status` and `doctor` on both homes | pass |

The final remote driver result was:

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
  "codexAndClaudeHomesRemainIsolated": true
}
```

The reproducible remote-side driver is
[`scripts/uat/daytona-product.mjs`](../../scripts/uat/daytona-product.mjs). It
requires an explicit destructive-UAT confirmation variable and an authorized,
disposable account because it creates remote state.

## Findings during the run

Production Better Auth correctly rejected state-changing browser requests that
omitted `Origin`; the driver now supplies the service origin. A first attempt
also established that one device-session token cannot be rebound to a second
device: the API rejected it with HTTP 409 and the CLI returned exit code 5.
The final run therefore authorizes each machine independently, matching the
product security model.

## Cleanup

After evidence capture, all UAT rows were removed from the new D1 control plane
in foreign-key-safe order and the exact UAT R2 prefix was deleted through the
Cloudflare dashboard. The superseded empty Worker, D1 database, and R2 bucket
whose names ended in `-mvp` were permanently removed after separate zero-row
and zero-object checks. The Daytona sandbox was deleted after this report was
written. Durable Object state uses an unguessable UAT vault identity and is no
longer reachable after control-plane cleanup; a general retention collector is
still a release-readiness item.
