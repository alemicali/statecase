# Native Linux + live Cloudflare background sync — 2026-09-08

Status: passed; packaged native-service/live-backend path
Test IDs: RT-004, RT-006, RT-013, RT-015; UAT-07 subset

## Candidate and topology

- CLI code at `8472dd6`, with the accompanying driver extension; no product
  implementation change was needed for this qualification.
- Clean installation of `@statecase/cli@0.1.0` from a newly packed tarball.
- Tarball SHA-256:
  `8702bddd7943b30fce4b2b2615f31fac59d045ff5f8bfcea5efb1a7915d6882a`.
- Node 22.22.3 and systemd 255; the service pins the package's actual Node
  interpreter and invokes its installed CLI entrypoint.
- Device A: hardened real systemd-user service, linked at runtime only.
- Device B: independently authorized foreground daemon with its own profile,
  local journal, and differently mapped Drop.
- Both installations are on the same Linux host. This is not a separate
  physical-peer or Daytona drill.
- Real API: `https://statecase-api.hi-0e6.workers.dev`, with existing production
  D1/R2/DO resources and schema through migration 0005.
- Previous Worker version: `9d4c611d-ad57-485c-a627-bb6c26892710`.
- Temporary allowlist Worker: `1ef5d8c7-7084-4f3d-ad92-12d2bae935f2`.
- Final canonical-allowlist Worker: `dd6894cf-d042-425b-9e3e-7906b75ede04`.

The same native-service scenario first passed against isolated local
workerd/D1/R2. Live enrollment then used a unique allowlisted synthetic email;
the packaged CLI created/joined the fixture vault normally. No user harness
directory, existing Statecase profile, keychain, or real session was read.

## Acceptance evidence

After initial setup push/pull, no manual sync/push/pull is called:

1. File writes propagate A to B and B to A automatically.
2. A's encrypted object PUT is held in a loopback fault proxy before upstream
   acceptance. Its SQLite journal already contains a running operation, while
   the scoped remote head remains unchanged.
3. SIGKILL is delivered through systemd, not a fabricated restart callback.
   Systemd automatically starts a new PID while A's proxy is offline; the
   original journal row remains present and queued status is visible.
4. B publishes a distinct change while A remains offline. A undergoes a second
   manager-driven SIGKILL/automatic restart before reconnecting.
5. Interrupted, offline, and peer changes converge without manual sync. The
   original interrupted operation eventually commits after its stale lease
   can be reclaimed.
6. Deletion propagates. The scoped cloud revision remains identical across
   45 idle seconds, covering maximum-reconcile and remote-poll cycles.
7. The driver stops/removes only its verified native fixture unit, terminates
   its child peer, closes proxies, and removes local credentials/data.

The live driver emitted `result: pass`, `runtime: systemd-user-plus-cli-peer`,
`backend: live-cloudflare`, and all acceptance flags true, then exited zero.
`remoteCleanupRequired: true` explicitly distinguished local cleanup from the
separate remote cleanup below. Local `npm run check` also passed 446 tests,
90.29% branch coverage, lint, typecheck, build, and clean-package installation.

## Remote cleanup and rollback

The orchestrator restored the canonical allowlist in its finally block.
A signup probe for the temporary address then returned
`403 SIGNUP_DISABLED`. A loopback-only maintenance Worker resolved only that
email's account and its one vault before listing its exact R2 prefix.

- Fixture account: `3VUSyt0aQSHSNwNM0zX973A0WV28Yrhd`.
- Fixture vault: `vlt_0a2aee046f924cc98d933c107fa0b20f`.
- R2: 12 fixture objects deleted; subsequent prefix list returned zero objects
  and `truncated: false`.
- D1: exact-target, foreign-key-ordered fixture cleanup; final read-only query
  returned zero users, vaults, devices, auth sessions, key envelopes, and audit
  events for these identities.
- Maintenance listener stopped; systemd reports `LoadState=not-found` and
  `ActiveState=inactive`.

Opaque coordinator metadata in the fixture vault's Durable Object was not
explicitly purged. No claim of deleting every DO record is made. Local package
and non-secret orchestration/report artifacts may remain; the driver removed
the generated credentials, recovery kit, data roots, and native definition.

## Reproduction controls and limits

The default `npm run uat:background` remains fully local. Opt-in native mode
requires `STATECASE_UAT_NATIVE_LINUX=1`, a persistent absolute
`STATECASE_UAT_PARENT` outside `/tmp`, and no existing Statecase unit. An optional
`STATECASE_UAT_CLI` selects the independently installed package entrypoint.

Live mode additionally requires the exact approved API URL,
`STATECASE_UAT_CONFIRM=create-and-modify-remote-state`, a uniquely prefixed
synthetic `STATECASE_UAT_EMAIL`, and an external absolute
`STATECASE_UAT_TARGETS` file for cleanup identities. The driver neither opens
signup nor deletes remote data by itself: an authorized operator must arrange
the narrowly scoped allowlist, guaranteed rollback, and exact-target cleanup.

This qualifies the combined native Linux/live-service path on this topology.
It does not qualify a physically separate peer, live launchd convergence,
machine reboot/sleep, real Codex/Claude resume, initialized submodules, or
independent security review. Those remain explicit release work.
