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
`--git-fetch ask|auto|never`; persistent clients default to `ask`, and explicitly
configured ephemeral automation may use `auto`. `ask` produces an actionable
`BASELINE_UNAVAILABLE` result before network or workspace mutation so a person
or agent can request approval; reattaching with `auto` records that approval for
the device. `never` requires manual provisioning. Auto mode invokes system Git
against the existing local `origin`, disables terminal credential prompts, uses
a bounded fetch, and never surfaces raw Git/remote diagnostics.

The same policy covers Git LFS objects required by a pinned baseline. Auto mode
uses the installed system `git-lfs`, attempts its local object cache first, and
only then performs a bounded non-interactive fetch from the checkout's existing
`origin`. Statecase validates the materialized size and SHA-256 and restores
partial results on failure. LFS credentials remain in device-local Git helpers;
they are never copied into Statecase configuration or output.

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

Git policy, shallow-fetch, LFS cache/fetch/integrity, failure-redaction,
cross-workspace rollback, secrets canaries, and ephemeral bootstrap UAT must
pass.
