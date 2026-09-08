# Authenticated background synchronization — 2026-09-08

Status: passed; local multi-process qualification only
Test IDs: RT-004, RT-006, RT-010 (filesystem component), RT-015; UAT-07 subset

## Candidate and environment

- CLI base commit `5cb53e3cfd31ced9491ddb12833ec215b93204a8` plus the accompanying
  standalone driver and CI wiring; no product-code change in this slice.
- Node 22.22.3, Wrangler 4.129.0, actual local workerd with D1, R2, and the vault
  Durable Object. All five current database migrations are applied normally.
- Two independently authorized device installations, separate STATECASE_HOME
  paths, separate local journals, different Drop paths, and real daemon child
  processes. No native service manager participates in this driver.
- Better Auth signup/device authorization and vault create/join use generated
  credentials, never fake tokens or an in-memory HTTP mock.
- Every account, key, profile, temporary file, database, and object belongs to
  one freshly created temporary fixture. HOME and harness paths are isolated;
  child TMPDIR is inside that fixture in the final driver.

Driver: `scripts/uat/background-sync.mjs`; command after building:

```bash
npm run build
npm run uat:background
```

## Acceptance sequence

Manual push/pull establishes the initial baseline only. After both daemons
start, the driver invokes status but never a manual sync/push/pull command.

1. Write a file on A; B receives it through automatic polling. Modify it on B;
   A receives the new bytes.
2. Hold A's next encrypted object PUT in a per-device loopback proxy before it
   reaches workerd. Read the local SQLite journal in read-only mode and verify
   that an operation is already `running`. Verify the remote head did not advance.
3. Set A's proxy offline and SIGKILL its owned daemon process group. Write an
   additional local file and restart offline. Verify queued status and the
   continued presence of the exact interrupted journal row.
4. B writes a distinct file and publishes while A remains offline. Kill and
   restart A offline again; reconnect its proxy.
5. Both devices receive the interrupted/offline/online files automatically.
   Verify that the original interrupted journal row eventually becomes
   `committed`, including recovery after its previous lease expires.
6. Delete a file on A and observe deletion on B. Compare the scoped namespace
   head across 45 idle seconds, covering at least one maximum reconciliation
   interval and two remote-poll intervals; no new revision is allowed.
7. Confirm both daemon processes remain alive, stop only owned fixture process
   groups, close proxies, and remove the complete temporary fixture.

The driver emits only phase/result flags. It never prints credentials, upstream
responses, session data, configuration contents, or full child diagnostics.
The proxy removes content encoding/length headers after Node fetch decompression;
otherwise it would corrupt responses by advertising a second decoding pass.
Revision checks use the protocol-1.1 namespace head, not the legacy vault head.
These two fixture defects were found and corrected before qualification.

The final driver passed every phase and exited zero with `result: pass`,
`interruptedUploadJournalReplay: true`, `idleNoop: true`, and
`cleanupVerified: true`. The preceding complete run also passed before the
final driver added an explicit check for B publishing while A remained offline
and isolated all child temporary paths under the fixture.

## Boundaries and release work

This is authenticated process-level evidence against the local production
implementation, not live Cloudflare deployment evidence. A held PUT is killed
before upstream acceptance; this does not simulate a partially accepted R2
write or a lost successful commit response. Native Linux/macOS lifecycle has
separate reports, but combining native managers with live-service multi-machine
convergence remains required. Real Codex/Claude use, session resume, machine
sleep/reboot, and indefinite unattended operation are not exercised here.

Local `npm run check` passed 446 tests, 90.29% overall branch coverage, lint,
typecheck, build, and clean-package installation. The new `background-sync` CI
job repeats this standalone scenario on Node 24 without external credentials.
