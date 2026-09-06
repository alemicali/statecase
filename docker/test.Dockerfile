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

COPY . .
RUN npm ci
RUN mkdir -p "$CODEX_HOME" "$CLAUDE_CONFIG_DIR" "$STATECASE_HOME" "$STATECASE_PACKAGE_SMOKE_ROOT"

CMD ["sh", "-c", "npm run check && npm run cloud:test"]
