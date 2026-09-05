# Repository policy

Status: normative
Last updated: 2026-09-05

## Purpose

This policy protects a project that can overwrite, retain, decrypt, and delete
valuable user state. Convenience never overrides data integrity, recoverability,
or secret handling.

## Branch and merge policy

`main` is protected and always releasable. Configure GitHub to require:

- pull requests; no direct pushes or force pushes;
- all checks named in `CI_POLICY.md`;
- resolved review conversations;
- at least one approving code-owner review;
- dismissal of stale approvals after relevant changes;
- linear history and squash merge;
- signed commits/tags for maintainers where GitHub plan and workflow permit;
- administrator enforcement except documented emergency response.

Delete merged branches automatically. Emergency fixes still use a pull request,
but may use an expedited review followed by a post-incident report.

## Change classification

| Class | Examples | Minimum evidence |
| --- | --- | --- |
| Documentation | wording, diagrams, non-normative examples | link/lint review |
| Normal | isolated CLI UX, refactor with unchanged behavior | tests + one review |
| Compatibility | public CLI/API/schema/adapter behavior | contract tests, changelog, migration note |
| Data-integrity critical | merge, journal, restore, tombstone, GC, materialization | ADR, failure tests, owner review |
| Security critical | crypto, auth, keys, tenant boundaries, secret handling | ADR/threat-model delta, security review, vectors/adversarial tests |
| Release/infrastructure | Worker, D1 migration, R2 policy, publishing | staging evidence, rollback plan, owner review |

A pull request author selects the highest applicable class. Splitting code does
not reduce classification when changes form one logical feature.

## Pull requests

Every pull request states:

- problem and scope;
- requirement/test IDs;
- architecture/security/data-loss impact;
- tests and UAT evidence;
- migration, rollback, and compatibility behavior;
- dependency and observability impact;
- documentation/changelog changes;
- explicit non-goals.

Pull requests should normally stay below 500 changed non-generated lines. Larger
changes require a review map and should be split into behavior-preserving
scaffolding, tests, and implementation slices.

## Test-first policy

No production mutation path is merged without a pre-existing failing test in
the pull request history or commit sequence. Required test IDs live in
`TEST_AND_UAT_PLAN.md`. Fixes add regression tests. Skips need an issue,
expiration date, and maintainer approval; critical/security tests cannot be
skipped.

Flaky tests are release blockers. Quarantine is time-bounded and may not remove
coverage of a critical invariant.

## Architecture decisions

Create `docs/adr/NNNN-title.md` for decisions affecting:

- trust/encryption/key hierarchy;
- protocol or manifest compatibility;
- logical identity and conflict semantics;
- storage/provider boundaries;
- deletion, retention, GC, migration, or restore;
- supported runtimes/harness formats;
- a new runtime dependency in crypto/auth/storage paths.

An ADR contains context, decision, alternatives, consequences, security and
privacy impact, migration/rollback, and test IDs. Supersede ADRs; do not rewrite
accepted history except typo/link fixes.

## Dependencies and supply chain

- Prefer platform APIs and small maintained libraries.
- Pin the lockfile and use `npm ci` in CI/releases.
- Runtime dependency additions require license, provenance, maintainer,
  transitive-size, and vulnerability review.
- Crypto primitives must come from reviewed libraries chosen by ADR; no custom
  primitives.
- Dependabot runs weekly. Critical runtime vulnerabilities block merging and
  release. High runtime vulnerabilities require immediate triage. Development
  advisories are triaged by exploitability and must not be silently ignored.
- GitHub Actions should be official or explicitly reviewed and pinned to a
  trusted major/immutable revision according to repository risk.

## Fixtures and test data

Only synthetic or irreversibly sanitized harness fixtures are committed. Each
fixture records harness version, platform, purpose, sanitizer, and expected
classification. A canary scan rejects tokens, private keys, email addresses,
personal home paths, and real session text.

Tests use temporary roots and fake keychain/cloud adapters. Access to real home
directories or production bindings is forbidden in automated tests.

## Versioning and compatibility

Use semantic versioning for the CLI/package and independent explicit versions
for API, manifest, object envelope, JSON output, and adapter schemas.

- Patch: compatible fixes.
- Minor: backward-compatible behavior and opt-in capabilities.
- Major: public breaking changes after migration and deprecation.

User-visible changes update `CHANGELOG.md`. Deprecations include replacement,
warning release, removal release, and recovery/rollback guidance. Historical
manifests are not rewritten in place.

## Releases

Releases are built from a reviewed `main` commit, tagged, reproducible where
practical, accompanied by checksums/provenance, and promoted through staging
before production. Publishing credentials use GitHub environment protections or
OIDC, never long-lived repository secrets when avoidable.

Release notes include compatible client/protocol/harness versions, D1/schema
migrations, known limitations, security changes, upgrade/rollback steps, and
UAT evidence. A release handling real sync data requires every release gate in
the strategy and test plan.

## Security and incident handling

Vulnerabilities use private GitHub security advisories or the contact in
`SECURITY.md`. Never ask reporters to attach real session content publicly.
Potential key/plaintext/tenant exposure triggers credential revocation guidance,
preservation of audit evidence, impact analysis, and a post-incident report.

## Documentation truthfulness

Target architecture documents must be labeled as design until implemented.
README install/usage examples describe released behavior only. Implemented
features link to tests and release versions; roadmap text may not imply
availability.
