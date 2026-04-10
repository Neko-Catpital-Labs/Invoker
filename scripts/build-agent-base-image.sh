#!/usr/bin/env bash
#
# build-agent-base-image.sh — generate the invoker/agent-base Docker image.
#
# This script is the SINGLE source of truth for the base image used by
# DockerExecutor. The Dockerfile content lives inline as a heredoc rather
# than as a committed file, because:
#   - the base image is not consumed directly by users (they FROM it),
#   - keeping it in one script makes the layer ownership obvious,
#   - the script and the resulting image rotate together.
#
# Usage:
#   bash scripts/build-agent-base-image.sh
#   TAG=my/custom-tag:dev bash scripts/build-agent-base-image.sh
#
# After build, downstream project images can:
#   FROM invoker/agent-base:latest
#   COPY . /app
#   RUN pnpm install
#
set -euo pipefail

TAG="${TAG:-invoker/agent-base:latest}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/Dockerfile" <<'DOCKERFILE'
FROM node:22-slim

# Core build/runtime tools used by Claude/Codex agents and most projects.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl jq git python3 make g++ ca-certificates openssh-client \
    && rm -rf /var/lib/apt/lists/*

# pnpm via corepack
RUN corepack enable && corepack prepare pnpm@latest --activate

# Claude CLI
RUN npm install -g @anthropic-ai/claude-code

# Non-root user. /home/invoker is owned by this user so ~/.cache works
# without UID compensators.
RUN useradd -m -s /bin/bash invoker \
    && mkdir -p /app && chown invoker:invoker /app

USER invoker
ENV HOME=/home/invoker
WORKDIR /app

# Git config the agent needs at runtime; safe.directory='*' lets the user
# operate on bind-mounted dirs (downstream images may override).
RUN git config --global --add safe.directory '*' \
    && git config --global user.name "Invoker Agent" \
    && git config --global user.email "invoker@local"

# Default command keeps the container alive when DockerExecutor starts it.
# DockerExecutor overrides Cmd to the same value; this default makes
# `docker run invoker/agent-base:latest` behave reasonably as well.
CMD ["tail", "-f", "/dev/null"]
DOCKERFILE

echo "[build-agent-base] building $TAG from $TMP/Dockerfile"
docker build -t "$TAG" "$TMP"
echo "[build-agent-base] tagged $TAG"
