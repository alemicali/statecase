# Statecase

> Take your agents anywhere. The encrypted Dropbox for agents: carry sessions,
> skills, context, and work in progress across every machine, so each agent
> picks up exactly where it left off.

Statecase is a new local-first, end-to-end encrypted portability layer for
agent harnesses. Codex and Claude are the first adapters; the architecture is
designed for agents generally.

## Status

Pre-alpha design and TDD scaffold. No synchronization, encryption, restore, or
cloud service is implemented yet. Do not use this repository with real agent
state.

The approved direction lives in:

- [Product strategy](docs/PRODUCT_STRATEGY.md)
- [Implementation specification](docs/IMPLEMENTATION_SPEC.md)
- [Test and UAT plan](docs/TEST_AND_UAT_PLAN.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Readiness review](docs/READINESS_REVIEW.md)

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
```

Production code follows test-first development and the controls in
[Repository policy](docs/REPOSITORY_POLICY.md).

## License

MIT
