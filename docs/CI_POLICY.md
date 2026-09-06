# Continuous integration policy

Status: normative
Last updated: 2026-09-05

## Required checks

Branch protection should require these logical checks on pull requests:

1. `quality` — lint, typecheck, coverage tests, build, package dry-run, and
   production dependency audit on the primary Node version.
2. `compatibility` — build and tests on every supported Node major.
3. `CodeQL` — JavaScript/TypeScript static security analysis, required once
   GitHub code scanning is available for the repository.
4. `Dependency Review` — blocks newly introduced vulnerable dependencies once
   GitHub dependency review is available for the repository.

Jobs use `npm ci`, minimum permissions, dependency caching, concurrency
cancellation, timeouts, and no production credentials. CI forks receive no
secrets.

## Runtime matrix

The maintained baseline is Node `>=22.12`. CI covers Node 22 and 24.
Adding/removing a runtime requires a compatibility ADR, package-engine update,
documentation, and release note. Cloud Worker tests use the compatibility date
committed in its Wrangler configuration rather than an implicit current date.

## Quality gates

- zero lint errors;
- strict TypeScript succeeds;
- all deterministic tests pass;
- build and declaration generation succeed;
- packed artifact contains only intended files;
- no high/critical production dependency advisory;
- repository-wide coverage never drops below the ratcheted baseline;
- new `core`, `protocol`, `crypto`, merge, restore, and auth code targets at
  least 90% branch coverage and complete critical-invariant tests.

The initial repository floor is intentionally lower than the target and is encoded
in Vitest. Raising it is one-way. Lowering it requires a policy exception issue
and owner approval; it must not be used to merge untested new code.

## Workflow tiers

### Pull request

Run quality and runtime compatibility. Add dependency review and CodeQL to the
required set as soon as GitHub exposes them for the repository. Core integration
tests use local Cloudflare emulation and fake identity; no network account or
personal harness directory.

### Main

Run the same suite without path-based skipping. Produce test/coverage artifacts
and a package dry-run. Main failures block releases and are repaired or reverted
immediately.

### Nightly

Once scripts exist, run extended property/fuzz seeds, fault injection, larger
storage fixtures, dependency audit, and performance trend jobs. A nightly
failure opens/updates a tracked issue and blocks a release even if PR CI passed.

### Release candidate

Run all deterministic, integration, fault, schema-evolution, recovery,
security, and performance suites plus documented UAT. During release qualification, remote
smoke tests use a uniquely prefixed disposable vault in the single remote stack
and never destructive shared fixtures. A separate staging/production promotion
flow is required before public launch.

## Test artifacts and retention

Failed integration/fault jobs upload only redacted logs, seeds, synthetic
manifests, and reports. Artifacts must pass a canary/secret scan. Never upload
decrypted fixtures, local paths, process environments, key material, or full
cloud request bodies. Keep PR artifacts briefly and release evidence according
to the release policy.

## Flake and retry policy

Workflows do not blindly retry test commands. A retry may be used only around a
known external service step and must preserve the first failure. Randomized
tests print a reproducible seed. A flaky correctness test is treated as a
product defect, not hidden by retries.

## Security automation

- CodeQL will run on pull requests, main, and a weekly schedule once code
  scanning is available. Its prepared workflow is restored at that gate.
- Dependabot proposes npm and GitHub Actions updates weekly.
- Dependency review rejects high/critical newly introduced advisories.
- Runtime `npm audit --omit=dev --audit-level=high` is blocking.
- Development-tool advisories are visible and triaged; an exploitable build or
  CI advisory blocks release.
- GitHub secret scanning and push protection must be enabled in repository
  settings when available.

At repository creation time, branch protection, code scanning, dependency
review, secret scanning, and push protection were unavailable for the private
repository on the current GitHub plan. This is an infrastructure limitation,
not a waived control. Before public release, make the repository public or
enable the required GitHub plan, restore the security workflows, enable these
settings, and record passing evidence.

## Policy exceptions

An exception requires a linked issue containing owner, exact check, risk,
mitigation, expiration, and removal plan. No exception may permit known silent
data loss, cross-tenant access, plaintext cloud exposure, unauthenticated
mutation, failed integrity verification, or irreversible restore behavior.
