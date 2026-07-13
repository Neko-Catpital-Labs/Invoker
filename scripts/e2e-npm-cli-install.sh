#!/usr/bin/env bash
# E2E: prove that `npm install` of the published npm packages yields a working
# `invoker-cli` command, using locally built release artifacts served over
# localhost instead of a GitHub release (both postinstalls honor
# INVOKER_RELEASE_BASE_URL).
#
# Usage: bash scripts/e2e-npm-cli-install.sh
#   INVOKER_E2E_SKIP_BUILD=1   reuse existing release/ artifacts
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This e2e script builds and installs macOS artifacts; run it on a Mac." >&2
  exit 64
fi

VERSION="$(node -p "require('./packages/npm-cli/package.json').version")"
ARCH="$(node -p "process.arch")"
CLI_TARBALL="release/invoker-cli-$VERSION-darwin-$ARCH.tar.gz"
UI_ZIP="release/Invoker-$VERSION-$ARCH.zip"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/invoker-e2e-npm.XXXXXX")"
SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

# 1. Build the real release artifacts locally.
if [ "${INVOKER_E2E_SKIP_BUILD:-0}" != "1" ]; then
  pnpm run dist:cli
  bash scripts/package-desktop.sh --mac "--$ARCH"
fi
for artifact in "$CLI_TARBALL" "$UI_ZIP"; do
  if [ ! -f "$artifact" ]; then
    echo "Missing $artifact — run without INVOKER_E2E_SKIP_BUILD=1 to build it." >&2
    exit 1
  fi
done
bash scripts/release-sha256.sh

# 2. Serve release/ on localhost so the postinstall download + sha
#    verification paths run for real.
PORT="${INVOKER_E2E_PORT:-8763}"
python3 -m http.server "$PORT" --directory release --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:$PORT/SHA256SUMS" >/dev/null 2>&1 && break
  sleep 0.2
done
curl -fsS "http://127.0.0.1:$PORT/SHA256SUMS" >/dev/null

# 3. Pack both npm packages (pnpm pack rewrites workspace:* to the exact
#    version, same as publish).
PACK_DIR="$SCRATCH/tarballs"
mkdir -p "$PACK_DIR"
pnpm --filter @neko-catpital-labs/invoker-cli pack --pack-destination "$PACK_DIR" >/dev/null
pnpm --filter @neko-catpital-labs/invoker-ui pack --pack-destination "$PACK_DIR" >/dev/null
CLI_TGZ="$(ls "$PACK_DIR"/*invoker-cli*.tgz)"
UI_TGZ="$(ls "$PACK_DIR"/*invoker-ui*.tgz)"

# 4. Install both tarballs in ONE command so npm satisfies the ui→cli
#    dependency from the local tarball instead of the registry.
PROJECT_DIR="$SCRATCH/project"
mkdir -p "$PROJECT_DIR"
(
  cd "$PROJECT_DIR"
  INVOKER_RELEASE_BASE_URL="http://127.0.0.1:$PORT" \
    npm install --no-fund --no-audit "$CLI_TGZ" "$UI_TGZ"
)

# 5. Assertions.
fail() { echo "FAIL: $1" >&2; exit 1; }

ACTUAL_VERSION="$("$PROJECT_DIR/node_modules/.bin/invoker-cli" --version)"
[ "$ACTUAL_VERSION" = "$VERSION" ] \
  || fail "node_modules/.bin/invoker-cli --version printed '$ACTUAL_VERSION', expected '$VERSION'"

# The ui package's own wrapper must resolve the dependency's vendor binary
# (proves the new bin entry works, independent of which package won .bin).
UI_WRAPPER_VERSION="$(node "$PROJECT_DIR/node_modules/@neko-catpital-labs/invoker-ui/bin/invoker-cli.js" --version)"
[ "$UI_WRAPPER_VERSION" = "$VERSION" ] \
  || fail "invoker-ui's invoker-cli wrapper printed '$UI_WRAPPER_VERSION', expected '$VERSION'"

[ -d "$PROJECT_DIR/node_modules/@neko-catpital-labs/invoker-ui/vendor/Invoker.app" ] \
  || fail "invoker-ui postinstall did not download/extract Invoker.app"

node -e "
  const pkg = require('$PROJECT_DIR/node_modules/@neko-catpital-labs/invoker-ui/package.json');
  if (!pkg.bin['invoker-cli']) throw new Error('invoker-ui is missing the invoker-cli bin entry');
  if (pkg.dependencies['@neko-catpital-labs/invoker-cli'] !== '$VERSION') {
    throw new Error('invoker-ui dependency is not pinned to $VERSION: ' + pkg.dependencies['@neko-catpital-labs/invoker-cli']);
  }
"

echo "ok npm install yields working invoker-cli $VERSION (direct bin + ui wrapper + pinned dependency)"
