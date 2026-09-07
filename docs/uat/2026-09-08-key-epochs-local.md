# Vault key epochs — local release-candidate qualification

Date: 2026-09-08
Status: automated local qualification passed; live packaged UAT not executed
Base commit: `f35db843c9777e83f3d336183b93cb389fc35e5c`
Candidate: the key-epoch changes on `feat/statecase-sync-core`

## Commands and results

- `npm run check`: 409 tests in 34 files, lint and typecheck passed;
  branch coverage 90.02% (2914/3237), statements 93.58%, functions 92.18%,
  lines 95.93%; CLI build and clean-prefix package installation passed.
- `npm run cloud:test`: 12 real workerd tests passed with the complete D1
  migration set, R2 bindings, and Durable Objects.
- `git diff --check`: passed.

All input, harness state, keys, accounts, and files were isolated synthetic
fixtures. No real user harness directories or production vault contents were
used. The cloud suite intentionally logs a sanitized `vault key rotation
outcome unavailable` error for its injected infrastructure-failure case.

## Reproduced defects and regression evidence

1. Disjoint offline edits conflicted after a root-key change because equality
   included ciphertext object IDs and chunk layout. Merge now compares
   authenticated content digests normalized to one epoch plus semantic
   metadata, preserving file-mode and true same-path conflicts.
2. A commit checked at HTTP ingress could arrive after rotation and still
   advance the vault. The final Durable Object decision now rechecks D1 and
   orders rotation with commits. A persisted minimum write epoch fences an
   ambiguous D1 result across subsequent invocations. Valid retry completes
   the fenced transition.
3. A stale capability request could insert after rotation. The insertion now
   checks the epoch and active owner transactionally, and no stale grant row
   survives rejection.
4. Re-registration without a key erased an existing device exchange key;
   replacing a key could also race envelope recipient discovery. Omitted keys
   are preserved and registered exchange keys are immutable in D1.
5. Unexpected D1 failures were classified as definite recipient rejection.
   They now remain ambiguous 5xx responses without breaking existing stubs;
   the write floor remains effective and a later valid rotation succeeds.
6. A stale recovery kit could add a replacement device before the CLI rejected
   the kit. Enrollment now checks the supplied recovery epoch inside D1
   membership insertion. Stale attempts add zero members; valid enrollment
   succeeds and existing owner roles remain unchanged.

Additional integration variants cover explicit and implicit epoch-one
manifests, empty/deleted namespaces, preview without remote mutation,
cross-epoch complete-record append merge, historical Drop/harness/Git restore,
preserved Session Capsule pins, and retained tombstones for files created and
deleted after the chosen restore point. Git restoration checks HEAD, index,
working tree, untracked files, rollback after commit failure, and convergence
in an independent clone.

## Unclaimed boundaries and follow-up gates

- This is not a Cloudflare deployment or a packaged Daytona rotation drill.
- The persistent-floor fixture and injected D1 failure prove fencing/retry,
  not an actual runtime process reset with a delayed in-flight D1 transaction.
- Multi-epoch offline CLI history ingestion, failure-path key-buffer cleanup,
  and recovery reconciliation after an already-superseded rotation still need
  expanded qualification before this slice is deployed.
- Native Linux/macOS daemon lifecycle, supported real harness version windows,
  and the remaining readiness/security/retention gates are unchanged.
