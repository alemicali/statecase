# ADR 0004: Authentication and device flow

Status: accepted
Date: 2026-09-05
Owners: Statecase maintainers
Test IDs: AU-001 through AU-011

## Context

Interactive laptops need browser-assisted login, while headless and ephemeral
machines need scoped non-interactive bootstrap. A CLI is a public client and
must not embed a reusable client secret.

## Decision

Use Better Auth on the Hono Worker with Cloudflare D1, its bearer support, and
the RFC 8628 device authorization plugin. The approval page is served by the
same HTTPS Worker and requires an authenticated account plus explicit approval.

Statecase bootstrap capabilities remain a separate application primitive:
short-lived, hashed at rest, single-use, vault/workspace/category scoped, and
unable to grant the secrets category. Persistent refresh/session material is
stored in the OS credential store; environment bootstrap tokens are consumed
without being printed.

## Alternatives considered

- Fully custom identity and device tokens: less code initially but creates a
  larger security protocol to design and maintain.
- Redirect-loop OAuth from the CLI: unreliable in remote shells and sandboxes.
- Long-lived API keys everywhere: simple but poorly scoped and difficult to
  rotate safely.

## Consequences

The Worker includes Better Auth and its D1 schema. Auth migrations and plugin
upgrades are security-sensitive. The application still owns vault membership,
device records, and bootstrap capability authorization.

## Security and privacy impact

All production authorization and approval traffic uses HTTPS. User codes are
short-lived, rate-limited, and non-secret only within their brief lifetime.
Refresh and bootstrap tokens are never stored plaintext remotely.

## Compatibility and migration

Auth routes live below `/api/auth`; Statecase API authorization remains
versioned below `/v1`. A later external identity provider can attach to Better
Auth without changing vault and encryption identities.

## Verification

AU-001 through AU-011, replay/rate-limit tests, cross-tenant tests, and a real
browser-to-CLI device approval UAT must pass.
