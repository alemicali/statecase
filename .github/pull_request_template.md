## What

<!-- Brief description of the change -->

## Why

<!-- Why is this change needed? Link to issue if applicable -->

## Scope and requirements

<!-- Requirement/test IDs from docs/TEST_AND_UAT_PLAN.md; list non-goals. -->

## Risk classification

<!-- docs / normal / compatibility / data-integrity / security / release -->

- Data loss or overwrite risk:
- Security/privacy/tenant impact:
- Public CLI/API/schema compatibility:
- Dependencies added or changed:

## How to test

<!-- Steps to verify this works -->

## Migration and rollback

<!-- State migration, failure behavior, rollback, or "not applicable". -->

## Evidence

<!-- Commands, CI links, UAT IDs, screenshots/redacted logs where useful. -->

## Checklist

- [ ] I wrote/updated a failing test before the implementation
- [ ] `npm run check` passes
- [ ] I tested failure, retry, and rollback paths where applicable
- [ ] I did not use real harness state, credentials, or session transcripts
- [ ] JSON/API/schema and adapter compatibility are documented where applicable
- [ ] ADR/threat-model delta is included for critical changes
- [ ] Updated CHANGELOG.md if user-facing
- [ ] Updated product/implementation/test docs if behavior or scope changed
