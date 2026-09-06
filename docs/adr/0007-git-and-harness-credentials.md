# ADR 0007: Git acquisition and harness credentials

Status: accepted
Date: 2026-09-05
Owners: Statecase maintainers
Test IDs: WS-010 through WS-032, AU-007, AU-011

## Context

Workspace capsules reference Git baselines that another machine may not have.
Harness configuration directories may also contain provider credentials whose
portability would greatly increase compromise impact.

## Decision

Use the system Git executable and existing device-local credential helpers.
Never serialize Git credentials. Baseline acquisition has
`--git-fetch=ask|auto|never`; interactive persistent clients default to `ask`,
and explicitly configured ephemeral automation may use `auto`.

Do not synchronize Codex, Claude, Git, or model-provider credentials in v1.
Classify them as excluded even when a broad harness root is selected. A future
secrets vault requires a separate ADR and explicit opt-in.

## Alternatives considered

- Require every baseline to be pre-provisioned: safest but breaks transparent
  ephemeral hydration.
- GitHub App cloning: useful for organizations, unnecessary for the initial
  personal release and not provider-neutral.
- Default credential synchronization: rejected due to blast radius.

## Consequences

Hydration can pause for Git authorization or report an unresolved baseline.
Users authenticate each harness independently on each machine.

## Security and privacy impact

No credential bytes enter manifests or R2. Process arguments and diagnostics
redact remote URLs that contain userinfo or tokens.

## Compatibility and migration

The policy is recorded per device/workspace, not in immutable capsule identity.
Adding an opt-in secrets compartment later does not alter normal scopes.

## Verification

Git helper/redaction tests, absent-baseline modes, secrets canaries, and
ephemeral bootstrap UAT must pass.
