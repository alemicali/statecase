# Contributing

Statecase handles security- and data-integrity-sensitive
state. Read `AGENTS.md`, `docs/PRODUCT_STRATEGY.md`,
`docs/IMPLEMENTATION_SPEC.md`, `docs/TEST_AND_UAT_PLAN.md`, and
`docs/THREAT_MODEL.md` before implementation work.

Every behavior change starts with a failing test linked to a requirement ID.
Run `npm run check` before opening a pull request. Follow
`docs/REPOSITORY_POLICY.md` for ADR, review, dependency, and release rules.

Never test against real harness directories, credentials, keychains, cloud
resources, or session transcripts.
