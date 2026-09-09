# Daytona and Cloudflare key-rotation UAT — 2026-09-08

Status: passed; packaged multi-device rotation/recovery path qualified

## Candidate and environment

- CLI base commit: `bac9193b2904d0d4b77060dfae180966b6d5213e`.
- Package: `@statecase/cli@0.1.0`; SHA-256
  `013e9b5149c7714d5b631876e53989ac0d185d283450dc5d17c1384129772552`.
  The uploaded package digest matched the locally packed artifact.
- API: `https://statecase-api.hi-0e6.workers.dev`.
- Test Worker version: `0f5277c2-349d-48bb-a9d3-c4af80bd53fd`.
- Final canonical-allowlist Worker version:
  `9d4c611d-ad57-485c-a627-bb6c26892710`.
- D1 migrations: `0001` through corrected `0005_vault_key_epochs.sql` applied.
- Disposable private sandbox: `6f2a41dc-218a-41da-b210-a811c3ab5dc3`,
  `daytona-small`, 1 CPU, 1 GiB RAM, 3 GiB disk; Node 25.9.0, npm 11.12.1,
  Git 2.55.0. Deleted after the run.
- Local gate: 432 tests, 90.12% branch coverage, lint/typecheck/build/package
  installation passed; 12 real-workerd tests passed. CI for `bac9193` passed
  quality and Node 22/24 compatibility jobs.

The standalone driver is
[`daytona-key-rotation.mjs`](../../scripts/uat/daytona-key-rotation.mjs).
It first passed against an isolated local Worker/D1/R2 stack, then ran from a
clean npm installation inside Daytona against the live service. Passwords,
device tokens, bootstrap secrets, recovery passphrases, and root keys were
generated/handled inside disposable fixtures, not printed by the driver.

## Acceptance evidence

The driver exercises four independently authorized persistent installations
(owner, offline peer, lost device, and clean replacement) plus two scoped
bootstrap installations. Every installation has its own home and data path.

| Check | Result |
| --- | --- |
| Initial enrollment and hydration | Owner publishes epoch one; peer, lost device, and scoped reader hydrate it |
| Existing recovery path | Rotation refuses to overwrite it; bytes unchanged |
| Device revocation | Lost device is excluded from eligible recipients |
| Fresh roots | Rotations to epochs two and three produce three distinct retained roots |
| Revoked persistent installation | Pull fails and preserves epoch-one local content |
| Pre-rotation scoped session | Pull fails and preserves epoch-one local content |
| Offline catch-up | Peer credentials remain untouched while offline, then one pull ingests both epochs and restores epoch-three content |
| Stale replacement kits | Epoch-one and epoch-two kits exit 6, leave credentials byte-identical, and add no membership |
| Current recovery kit | Clean replacement joins with epoch-three kit and pulls current content |
| Fresh scoped access | Newly issued epoch-three bootstrap hydrates current content |
| Historical restore preview | Epoch-one restore preview leaves epoch-three local content unchanged |
| Cross-epoch restore | Restore publishes a new revision at the current epoch; owner, peer, replacement, and fresh scoped reader converge on historical content |

The original complete driver asserted nonzero exit status for revoked access.
A follow-up command on the same live fixtures, before cleanup, additionally
verified exact denial classes: revoked persistent device exits **4**, revoked
scoped session exits **3**. The checked-in driver now requires one of these
auth/authz denials, so a network error cannot satisfy those assertions.

Successful run identities:

```json
{
  "vaultId": "vlt_214700b7f5774f468112d3ccae3bb124",
  "dropId": "drop_7a5dfdcd6bdc44dda6688b49addd8e79",
  "finalKeyEpoch": 3,
  "historicalRevisionId": "srev_294b22718f8e46e4969ff9fccca69455",
  "restoredRevisionId": "srev_49517ba2ae074f6e91005ccd3f075446"
}
```

## Deployment defect reproduced and corrected

The first remote migration attempt failed with `incomplete input`, although
fresh local migrations and workerd invariant tests passed. Read-only checks
confirmed the remote database still had only migrations 0001–0004, no key-epoch
column, and none of the new triggers/tables. The Worker was not updated during
that failed attempt.

This matches the remote D1 parser's known handling of bare `CASE … END` inside
triggers ([Cloudflare issue 4727](https://github.com/cloudflare/workers-sdk/issues/4727)).
The migration now expresses the same predicates as `SELECT RAISE(...) WHERE …`.
The 12 workerd tests still passed, the ordinary remote migration command
succeeded, and the packaged live drill above qualified the resulting schema.
No failed migration was marked as applied and no old epoch was manually forced.

## Cleanup and boundaries

The final deployment restored the one-address production signup allowlist.
A signup probe for the disposable address returned `403 SIGNUP_DISABLED`.
A loopback-only maintenance Worker resolved the exact UAT account/vault, listed
only its R2 prefix, deleted **8** encrypted objects, and verified zero remaining
objects. D1 cleanup removed only that account's fixture records in foreign-key
order, including the new key envelopes. The sandbox was deleted and absent
from the subsequent inventory; the unrelated existing sandbox remained present.
The final exact-target D1 query returned zero users, vaults, devices, key
envelopes, and audit events. The temporary maintenance listener was stopped.

This qualifies packaged foreground rotation, revocation, offline history,
replacement recovery, scoped reissuance, and cross-epoch Drop restore on the
tested profile. It does **not** qualify an actual coordinator process reset
with a delayed in-flight D1 mutation, independent crypto/security review,
native systemd/launchd lifecycle, real-version harness resume certification,
initialized-submodule hydration, or aged live retention. Those remain separate
release gates; this report is not a public-production readiness declaration.
