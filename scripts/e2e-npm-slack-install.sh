#!/usr/bin/env bash
# E2E: prove that `npm install` of @neko-catpital-labs/invoker-slack yields a
# working `invoker-slack` command, using a locally built release artifact served
# over localhost instead of a GitHub release (postinstall honors
# INVOKER_RELEASE_BASE_URL).
#
# Usage: bash scripts/e2e-npm-slack-install.sh
#   INVOKER_E2E_SKIP_BUILD=1   reuse existing release/ artifacts
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./packages/npm-slack/package.json').version")"
PLATFORM="$(node -p "process.platform")"
ARCH="$(node -p "process.arch")"
SLACK_TARBALL="release/invoker-slack-$VERSION-$PLATFORM-$ARCH.tar.gz"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/invoker-e2e-npm-slack.XXXXXX")"
SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

if [ "${INVOKER_E2E_SKIP_BUILD:-0}" != "1" ]; then
  pnpm run dist:slack
fi
if [ ! -f "$SLACK_TARBALL" ]; then
  echo "Missing $SLACK_TARBALL — run without INVOKER_E2E_SKIP_BUILD=1 to build it." >&2
  exit 1
fi
bash scripts/release-sha256.sh

PORT="${INVOKER_E2E_PORT:-8764}"
python3 -m http.server "$PORT" --directory release --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:$PORT/SHA256SUMS" >/dev/null 2>&1 && break
  sleep 0.2
done
curl -fsS "http://127.0.0.1:$PORT/SHA256SUMS" >/dev/null

PACK_DIR="$SCRATCH/tarballs"
mkdir -p "$PACK_DIR"
pnpm --filter @neko-catpital-labs/invoker-slack pack --pack-destination "$PACK_DIR" >/dev/null
SLACK_TGZ="$(ls "$PACK_DIR"/*invoker-slack*.tgz)"

PROJECT_DIR="$SCRATCH/project"
mkdir -p "$PROJECT_DIR"
(
  cd "$PROJECT_DIR"
  INVOKER_RELEASE_BASE_URL="http://127.0.0.1:$PORT" \
    npm install --no-fund --no-audit "$SLACK_TGZ"
)

fail() { echo "FAIL: $1" >&2; exit 1; }

ACTUAL_VERSION="$("$PROJECT_DIR/node_modules/.bin/invoker-slack" --version)"
[ "$ACTUAL_VERSION" = "$VERSION" ] \
  || fail "node_modules/.bin/invoker-slack --version printed '$ACTUAL_VERSION', expected '$VERSION'"

[ -x "$PROJECT_DIR/node_modules/@neko-catpital-labs/invoker-slack/vendor/invoker-slack" ] \
  || fail "invoker-slack postinstall did not install vendor binary"

echo "ok npm install yields working invoker-slack $VERSION"
