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

## Additional offline and failure-path qualification

Follow-up candidate based on `802343b`:

- `npm run check`: 432 tests in 35 files passed; lint, typecheck, build, and
  clean-prefix package installation passed. Branch coverage 90.12%
  (2947/3270), statements 93.71%, functions 92.25%, lines 96.04%.
- The new `vault-keys.ts` module has 100% branch/line/function/statement coverage.
- `npm run cloud:test`: 12 workerd/D1/R2/DO tests passed.
- Two production-Argon2id-heavy integration tests exceeded the default
  five-second test deadline under local load. Their explicit deadline is now
  30 seconds; crypto cost parameters, assertions, coverage thresholds, and
  ordinary test deadlines are unchanged. A timed-out asynchronous test had
  also raced fixture/environment cleanup; the complete rerun above passed.

- A CLI peer stays offline through epochs two and three. A missing epoch or a
  forged later envelope fails without changing credential bytes or local file
  content. Restoring the valid history makes one subsequent pull converge.
- History ingestion persists once only after authenticating the entire
  contiguous sequence; schema, gap, truncation, authentication, network, and
  persistence failures release all owned key buffers. Canonical legacy and
  full historical rings, no-op refresh, and early command failure are covered.
- A committed rotation with an unavailable reconciliation endpoint and a
  connection failure followed by an old-epoch read both retain the candidate
  recovery kit and prior local epoch. A lost response already superseded by
  another rotation is matched against its exact historical envelope; the
  following sync catches up to the newer root.
- Regression tests reproduced unwiped derived-key buffers on historical rekey
  download/cleanup failures and on concurrent session append merge. The fixed
  paths release them without wiping the caller's root keys. Failed restore
  rolls back local content and leaves the remote revision unchanged.
- A separate regression reproduced an unclaimed merged plaintext stage when
  input cleanup failed. The merge now completes input cleanup before passing
  ownership to its caller and releases the merged stage on failure. Both
  epochs one and two cover successful merge, base/remote download failures,
  cleanup failure, unchanged remote head, and a successful retry.

These assertions inspect explicitly owned mutable buffers only; they do not
prove erasure of immutable JavaScript strings or all process/library copies.

## Unclaimed boundaries and follow-up gates

- This is not a Cloudflare deployment or a packaged Daytona rotation drill.
- The persistent-floor fixture and injected D1 failure prove fencing/retry,
  not an actual runtime process reset with a delayed in-flight D1 transaction.
- Native Linux/macOS daemon lifecycle, supported real harness version windows,
  and the remaining readiness/security/retention gates are unchanged.
