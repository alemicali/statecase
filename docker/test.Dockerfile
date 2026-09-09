FROM node:22-bookworm-slim

WORKDIR /workspace
ENV CI=1 \
    HOME=/tmp/statecase-synthetic-home \
    STATECASE_HOME=/tmp/statecase-synthetic-home/.statecase \
    CODEX_HOME=/tmp/statecase-synthetic-home/.codex \
    CLAUDE_CONFIG_DIR=/tmp/statecase-synthetic-home/.claude \
    STATECASE_PACKAGE_SMOKE_ROOT=/workspace/.package-smoke

RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ git make python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json .npmrc ./
COPY apps/cli/package.json ./apps/cli/package.json
COPY apps/cloud/package.json ./apps/cloud/package.json
COPY packages/adapters/claude/package.json ./packages/adapters/claude/package.json
COPY packages/adapters/codex/package.json ./packages/adapters/codex/package.json
COPY packages/adapters/common/package.json ./packages/adapters/common/package.json
COPY packages/chunking/package.json ./packages/chunking/package.json
COPY packages/crypto/package.json ./packages/crypto/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY packages/runtime/package.json ./packages/runtime/package.json
COPY packages/storage-local/package.json ./packages/storage-local/package.json
COPY packages/sync-core/package.json ./packages/sync-core/package.json
COPY packages/workspace/package.json ./packages/workspace/package.json
RUN npm ci --include=optional \
    && test -x node_modules/@cloudflare/workerd-linux-64/bin/workerd
COPY . .
RUN mkdir -p "$CODEX_HOME" "$CLAUDE_CONFIG_DIR" "$STATECASE_HOME" "$STATECASE_PACKAGE_SMOKE_ROOT"

CMD ["sh", "-c", "npm run check && npm run cloud:test"]
