#!/usr/bin/env bash
#
# e2e-docker-hello-world.sh — end-to-end smoke test for the static-image
# DockerExecutor architecture.
#
# What it exercises:
#   1. scripts/build-agent-base-image.sh produces invoker/agent-base:latest
#   2. A downstream fixture image (FROM invoker/agent-base:latest) builds
#   3. DockerExecutor can create a container from the fixture image
#   4. DockerExecutor forwards a host secrets.env file into the container
#      so the Claude CLI can authenticate with ANTHROPIC_API_KEY
#   5. A single ai_task plan completes end-to-end
#
# Preflight requirements:
#   - docker daemon reachable
#   - $ANTHROPIC_API_KEY exported in the host shell
#
# Exit codes:
#   0 — task completed
#   2 — preflight failed (docker missing, api key missing, etc.)
#   non-zero — invoker headless run failed
#
# Usage:
#   bash scripts/e2e-docker-hello-world.sh
#

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE_DIR="$ROOT/scripts/fixtures/hello-world-agent"
BASE_TAG="invoker/agent-base:latest"
FIXTURE_TAG="invoker-e2e-hello:latest"

# ── Preflight ────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || {
  echo "[e2e] docker CLI not installed"
  exit 2
}
docker info >/dev/null 2>&1 || {
  echo "[e2e] docker daemon not reachable"
  exit 2
}
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "[e2e] ANTHROPIC_API_KEY must be set"
  exit 2
fi

# ── Build base image if missing ──────────────────────────────
if ! docker image inspect "$BASE_TAG" >/dev/null 2>&1; then
  echo "[e2e] building $BASE_TAG"
  bash "$ROOT/scripts/build-agent-base-image.sh"
fi

# ── Build fixture image if missing ───────────────────────────
if ! docker image inspect "$FIXTURE_TAG" >/dev/null 2>&1; then
  echo "[e2e] building $FIXTURE_TAG"
  docker build -t "$FIXTURE_TAG" -f "$FIXTURE_DIR/Dockerfile" "$FIXTURE_DIR"
fi

# ── Temp secrets file + invoker config ───────────────────────
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

SECRETS="$TMP/secrets.env"
printf 'ANTHROPIC_API_KEY=%s\n' "$ANTHROPIC_API_KEY" > "$SECRETS"
chmod 600 "$SECRETS"

CONFIG="$TMP/config.json"
cat > "$CONFIG" <<JSON
{
  "docker": {
    "imageName": "$FIXTURE_TAG",
    "secretsFile": "$SECRETS"
  }
}
JSON

# ── Run invoker headless ─────────────────────────────────────
export INVOKER_REPO_CONFIG_PATH="$CONFIG"
cd "$ROOT"
echo "[e2e] launching invoker headless run on hello-world plan"
./run.sh --headless run "$FIXTURE_DIR/plan.yaml"

echo "[e2e] hello-world task completed successfully"
