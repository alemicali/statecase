# Statecase

> Take your agents anywhere. The encrypted Dropbox for agents: carry sessions,
> skills, context, and work in progress across every machine, so each agent
> picks up exactly where it left off.

Statecase is a new local-first, end-to-end encrypted portability layer for
agent harnesses. Codex and Claude are the first adapters; the architecture is
designed for agents generally.

## Status

Private MVP. The manual CLI path is implemented and the Cloudflare stack is
live at `https://statecase-api-mvp.hi-0e6.workers.dev`: Better Auth device
authorization, D1 identity/catalogue, R2 encrypted objects, Durable Object
commits, local XChaCha20-Poly1305 encryption, passphrase-protected recovery
kits, Codex/Claude session and skill adapters, Git working overlays, arbitrary
Drops, logical workspace remapping, and the canonical agent skill.

The daemon, transparent harness shims, automatic three-way merge, tombstone
propagation, retained snapshots, scoped ephemeral capabilities, and full
historical Session Capsules remain release gates. Until those land, use manual
`push`, `pull`, or `sync` and keep the recovery kit offline. This is not a
public-production release.

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
./apps/cli/dist/bin.js workspace attach --auto --path /path/to/checkout
./apps/cli/dist/bin.js setup --harness codex,claude
./apps/cli/dist/bin.js push --dry-run
./apps/cli/dist/bin.js push
```

On a second machine, login, join the vault with the encrypted recovery kit,
attach the same logical Git workspace at its new local path, map any Drops by
their non-secret IDs, then run `pull`. `setup` installs the Statecase skill into
both the Codex-compatible `.agents/skills` root and Claude's skills root.

Account creation is deliberately allowlisted for the private MVP. Never put
`STATECASE_TOKEN`, `STATECASE_RECOVERY_PASSPHRASE`, or the recovery kit in a
prompt, Git repository, shell history, or process argument.

Production code follows test-first development and the controls in
[Repository policy](docs/REPOSITORY_POLICY.md).

## License

MIT
