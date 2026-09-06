# Statecase

> Take your agents anywhere. The encrypted Dropbox for agents: carry sessions,
> skills, context, and work in progress across every machine, so each agent
> picks up exactly where it left off.

Statecase is a new local-first, end-to-end encrypted portability layer for
agent harnesses. Codex and Claude are the first adapters; the architecture is
designed for agents generally.

## Status

Private alpha. The foreground portability path is implemented and the Cloudflare stack is
live at `https://statecase-api-mvp.hi-0e6.workers.dev`: Better Auth device
authorization, D1 identity/catalogue, R2 encrypted objects, Durable Object
commits, local XChaCha20-Poly1305 encryption, passphrase-protected recovery
kits, Codex/Claude session and skill adapters, exact Git index/worktree overlays, arbitrary
Drops, logical workspace remapping, deletion tombstones, transactional local
materialization, a crash-safe runtime journal, transparent harness shims, and
the canonical agent skill. `statecase run codex|claude` performs a bounded
preflight pull, supervises the unmodified harness, publishes periodically, and
attempts a final flush without preventing offline use or changing the child
exit status.

The persistent daemon can run with `statecase daemon foreground` or be installed
as a systemd user service / macOS LaunchAgent. Real-OS service UAT, append-aware
same-session merge, automatic missing-baseline fetch, initialized-submodule
hydration, automatic retention/in-place restore, scoped ephemeral capabilities,
post-revocation key rewrapping, and full historical Session Capsules remain
release gates. This is not yet a public-production release.

The approved direction lives in:

- [Product strategy](docs/PRODUCT_STRATEGY.md)
- [Implementation specification](docs/IMPLEMENTATION_SPEC.md)
- [Test and UAT plan](docs/TEST_AND_UAT_PLAN.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Readiness review](docs/READINESS_REVIEW.md)
- [Private MVP operations](docs/MVP_OPERATIONS.md)

## Repository shape

```text
apps/       deployable CLI, daemon, Worker, and later dashboard
packages/   domain, protocol, crypto, storage, adapters, workspace, and Drops
skills/     agent-native Statecase skills
docs/       product, implementation, security, tests, policy, and ADRs
```

Statecase is a standalone greenfield product. It does not depend on AgentStash,
ClawStash, or Restic.

## Development

```bash
npm ci
npm run check
npm run cloud:test
docker compose -f compose.test.yaml run --rm --build test
```

Build and run the CLI without installing anything globally:

```bash
npm run build
./apps/cli/dist/bin.js --json status
```

Node.js 22.12+ and system Git are required. Git provides workspace identity and
working-tree overlays; Statecase never synchronizes Git credentials.

## First private-MVP setup

```bash
./apps/cli/dist/bin.js login
read -rsp 'Recovery passphrase: ' STATECASE_RECOVERY_PASSPHRASE && export STATECASE_RECOVERY_PASSPHRASE
printf '\n'
./apps/cli/dist/bin.js vault create personal --recovery-file "$PWD/personal.statecase-recovery.json"
unset STATECASE_RECOVERY_PASSPHRASE
./apps/cli/dist/bin.js workspace attach --auto --path /path/to/checkout --mode git-overlay
./apps/cli/dist/bin.js setup --harness codex,claude --transparent
# Prepend the path printed by setup to PATH, then verify both shims:
./apps/cli/dist/bin.js shim verify codex
./apps/cli/dist/bin.js shim verify claude
./apps/cli/dist/bin.js push --dry-run
./apps/cli/dist/bin.js push
```

On a second machine, login, join the vault with the encrypted recovery kit,
attach the same logical Git workspace at its new local path, map any Drops by
their non-secret IDs, then run `pull`. `setup` installs the Statecase skill into
both the Codex-compatible `.agents/skills` root and Claude's skills root.
Use the generated shims, the installed daemon, or invoke `statecase run codex
-- <args>` / `statecase run claude -- <args>` explicitly.
`statecase bypass codex -- <args>` starts the recorded real executable without
synchronization.

For a persistent process under an existing supervisor:

```bash
./apps/cli/dist/bin.js daemon foreground
./apps/cli/dist/bin.js daemon status
./apps/cli/dist/bin.js daemon install
```

The daemon owns one profile lock, watches mapped roots, polls the remote head,
reconciles on a maximum deadline, retries with jitter, and exposes status only
through an owner-only Unix socket. Service definitions are Statecase-owned,
atomically written, hardened on systemd, and safely removable with
`daemon uninstall --yes`; release claims still require Linux and macOS UAT.

Use `device list` to inspect stable installation identities and `device revoke
<id> --yes` to block a lost installation and all of its bound service sessions.
Revocation prevents future server access; it cannot erase plaintext already
present on the lost machine.

Protect the current remote head with `snapshot create <name>`, inspect it with
`snapshot list`, and recover one configured namespace without touching the
live head using `restore --revision <id> --mapping <id> --target <staging-dir>`.
Statecase refuses a non-empty staging target unless `--yes` is explicit, and
normal conflict checks still apply after confirmation.

Offline edits to different files or session records merge automatically against
the last revision each device actually applied. Same-path divergence fails with
explicit paths. After inspecting the remote side through staging restore, an
intentional local winner can be published with `conflicts resolve --mapping
<id> --strategy local --yes`; Statecase first protects the exact remote head.

Account creation is deliberately allowlisted for the private MVP. Never put
`STATECASE_TOKEN`, `STATECASE_RECOVERY_PASSPHRASE`, or the recovery kit in a
prompt, Git repository, shell history, or process argument.

Production code follows test-first development and the controls in
[Repository policy](docs/REPOSITORY_POLICY.md).

## License

MIT
