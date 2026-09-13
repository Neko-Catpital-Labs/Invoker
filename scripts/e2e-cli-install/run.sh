#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$ROOT/scripts/e2e-cli-install"
cd "$ROOT"

USE_DOCKER=0
SKIP_BUILD="${INVOKER_E2E_SKIP_BUILD:-0}"
KEEP_SANDBOX=0
for arg in "$@"; do
  case "$arg" in
    --docker) USE_DOCKER=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --keep-sandbox) KEEP_SANDBOX=1 ;;
    -h|--help)
      echo "Usage: bash scripts/e2e-cli-install/run.sh [--docker] [--skip-build] [--keep-sandbox]"
      echo "  --docker         run the same suite inside a node:26 container (hermetic, Linux)"
      echo "  --skip-build     reuse an existing release/ CLI tarball"
      echo "  --keep-sandbox   leave the sandbox directory in place for inspection"
      exit 0
      ;;
    *) echo "unknown flag: $arg (try --help)" >&2; exit 64 ;;
  esac
done

fail() { echo "FAIL: $1" >&2; exit 1; }

if [ "$USE_DOCKER" = "1" ]; then
  command -v docker >/dev/null 2>&1 || fail "--docker needs a docker daemon on PATH"
  IMAGE="invoker-e2e-cli-install:local"
  echo "==> building $IMAGE"
  docker build -f "$HERE/Dockerfile" -t "$IMAGE" "$ROOT"
  echo "==> running the suite inside $IMAGE"
  exec docker run --rm "$IMAGE"
fi

REAL_HOME="$HOME"
command -v npm >/dev/null 2>&1 || fail "npm is required"
REAL_NPM_PREFIX="$(npm prefix -g)"
[ -n "$REAL_NPM_PREFIX" ] || fail "could not read the real global npm prefix"

HOST_WITNESS_PATHS=(
  "$REAL_HOME/.claude.json"
  "$REAL_HOME/.claude/skills"
  "$REAL_HOME/.claude/settings.json"
  "$REAL_HOME/.cursor/mcp.json"
  "$REAL_HOME/.cursor/skills"
  "$REAL_HOME/.cursor/rules"
  "$REAL_HOME/.codex/config.toml"
  "$REAL_HOME/.codex/skills"
  "$REAL_HOME/.codex/AGENTS.md"
  "$REAL_HOME/.omp/agent"
  "$REAL_HOME/.invoker"
  "$REAL_NPM_PREFIX/lib/node_modules/@neko-catpital-labs"
  "$REAL_NPM_PREFIX/bin/invoker-cli"
)

hash_stdin() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | cut -d' ' -f1
  else
    sha256sum | cut -d' ' -f1
  fi
}

stat_tree() {
  find "$1" -exec stat -f '%N %m %z' {} + 2>/dev/null \
    || find "$1" -exec stat -c '%n %Y %s' {} + 2>/dev/null
}

snapshot_host() {
  local out="$1" path fingerprint
  : > "$out"
  for path in "${HOST_WITNESS_PATHS[@]}"; do
    if [ ! -e "$path" ]; then
      printf '%s\tABSENT\n' "$path" >> "$out"
      continue
    fi
    fingerprint="$(stat_tree "$path" | LC_ALL=C sort | hash_stdin)"
    [ -n "$fingerprint" ] \
      || fail "could not fingerprint $path, so 'the host is untouched' would be UNCHECKED"
    printf '%s\t%s\n' "$path" "$fingerprint" >> "$out"
  done
}

VERSION="$(node -p "require('$ROOT/packages/npm-cli/package.json').version")"
UI_VERSION="$(node -p "require('$ROOT/packages/npm-ui/package.json').version")"
PLATFORM="$(node -p "process.platform")"
ARCH="$(node -p "process.arch")"
CLI_ASSET="invoker-cli-$VERSION-$PLATFORM-$ARCH.tar.gz"
if [ "$PLATFORM" = "darwin" ]; then
  UI_ASSET="Invoker-$UI_VERSION-$ARCH.zip"
else
  UI_ARCH="$ARCH"
  [ "$ARCH" = "x64" ] && UI_ARCH="x86_64"
  UI_ASSET="Invoker-$UI_VERSION-$UI_ARCH.AppImage"
fi

if [ "$SKIP_BUILD" != "1" ]; then
  if [ "$(node -p "String(process.config.variables.single_executable_application)")" != "true" ]; then
    fail "this node ($(node -p "process.execPath")) was built with single_executable_application=false, so \`pnpm run dist:cli\` cannot produce release/$CLI_ASSET.
  Homebrew's node is built this way. Either run this suite with --docker (the node:26 image has SEA enabled),
  or build the artifact on a SEA-capable node and re-run with --skip-build."
  fi
  echo "==> building the real CLI release artifact (pnpm run dist:cli)"
  pnpm run dist:cli
fi
[ -f "$ROOT/release/$CLI_ASSET" ] || fail "missing release/$CLI_ASSET — run without --skip-build to build it"

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/invoker-e2e-cli-install.XXXXXX")"
REGISTRY_PID=""
cleanup() {
  [ -n "$REGISTRY_PID" ] && kill "$REGISTRY_PID" 2>/dev/null || true
  if [ "$KEEP_SANDBOX" = "1" ]; then
    echo "==> sandbox kept at $SANDBOX"
  else
    rm -rf "$SANDBOX"
  fi
}
trap cleanup EXIT

mkdir -p "$SANDBOX/home/.invoker" "$SANDBOX/npm" "$SANDBOX/db" "$SANDBOX/bin" \
         "$SANDBOX/serve" "$SANDBOX/tarballs" "$SANDBOX/work"

echo "==> staging release artifacts (real CLI binary, stub desktop app)"
cp "$ROOT/release/$CLI_ASSET" "$SANDBOX/serve/$CLI_ASSET"
if [ "$PLATFORM" = "darwin" ]; then
  mkdir -p "$SANDBOX/work/stub/Invoker.app/Contents"
  echo "invoker e2e stub, not a real application bundle" > "$SANDBOX/work/stub/Invoker.app/Contents/STUB"
  (cd "$SANDBOX/work/stub" && zip -qr "$SANDBOX/serve/$UI_ASSET" "Invoker.app")
else
  echo "invoker e2e stub AppImage" > "$SANDBOX/serve/$UI_ASSET"
fi
(
  cd "$SANDBOX/serve"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 ./* | sed 's|\*\{0,1\}\./||' > SHA256SUMS
  else
    sha256sum ./* | sed 's|\*\{0,1\}\./||' > SHA256SUMS
  fi
)

echo "==> packing the npm packages from this checkout"
pnpm --filter @neko-catpital-labs/invoker-cli pack --pack-destination "$SANDBOX/tarballs" >/dev/null
pnpm --filter @neko-catpital-labs/invoker-ui pack --pack-destination "$SANDBOX/tarballs" >/dev/null
CLI_TGZ="$(ls "$SANDBOX/tarballs"/*invoker-cli*.tgz)"
UI_TGZ="$(ls "$SANDBOX/tarballs"/*invoker-ui*.tgz)"

echo "==> starting the fixture npm registry"
node "$HERE/lib/fixture-registry.mjs" \
  --release-dir="$SANDBOX/serve" \
  --package="@neko-catpital-labs/invoker-cli::$VERSION::$CLI_TGZ" \
  --package="@neko-catpital-labs/invoker-ui::$UI_VERSION::$UI_TGZ" \
  > "$SANDBOX/registry.out" 2> "$SANDBOX/registry.err" &
REGISTRY_PID=$!
REGISTRY_URL=""
for _ in $(seq 1 60); do
  if [ -s "$SANDBOX/registry.out" ]; then
    REGISTRY_URL="$(sed -n 's/^REGISTRY_URL=//p' "$SANDBOX/registry.out" | head -1)"
    [ -n "$REGISTRY_URL" ] && break
  fi
  sleep 0.2
done
[ -n "$REGISTRY_URL" ] || fail "fixture registry never reported a URL; stderr: $(cat "$SANDBOX/registry.err")"
curl -fsS "$REGISTRY_URL/@neko-catpital-labs/invoker-cli" >/dev/null \
  || fail "fixture registry did not serve the invoker-cli packument"

for tool in brew apt-get sudo; do
  cat > "$SANDBOX/bin/$tool" <<'TRIPWIRE'
#!/usr/bin/env bash
printf '%s %s\n' "$(basename "$0")" "$*" >> "$INVOKER_E2E_TRIPWIRE_LOG"
echo "invoker e2e sandbox: refused to run '$(basename "$0") $*'" >&2
exit 127
TRIPWIRE
  chmod +x "$SANDBOX/bin/$tool"
done

for harness in claude codex cursor omp; do
  cat > "$SANDBOX/bin/$harness" <<'HARNESS'
#!/usr/bin/env bash
echo "invoker e2e stub harness: $(basename "$0") 0.0.0-e2e"
exit 0
HARNESS
  chmod +x "$SANDBOX/bin/$harness"
done

snapshot_host "$SANDBOX/host-before.tsv"

export HOME="$SANDBOX/home"
export npm_config_prefix="$SANDBOX/npm"
export INVOKER_DB_DIR="$SANDBOX/db"
export INVOKER_REPO_CONFIG_PATH="$SANDBOX/home/.invoker/config.json"
export INVOKER_RELEASE_BASE_URL="$REGISTRY_URL/release"
export INVOKER_E2E_TRIPWIRE_LOG="$SANDBOX/tripwire.log"
export PATH="$SANDBOX/bin:$PATH"
export npm_config_update_notifier=false
: > "$INVOKER_E2E_TRIPWIRE_LOG"
cat > "$SANDBOX/home/.npmrc" <<NPMRC
@neko-catpital-labs:registry=$REGISTRY_URL
prefix=$SANDBOX/npm
NPMRC

. "$HERE/lib/sandbox-guard.sh"
invoker_sandbox_assert_safe "$SANDBOX" "$REAL_HOME"

echo "==> running the README one-liner for real: npx @neko-catpital-labs/invoker-cli install"
INSTALL_STATUS=0
(
  cd "$SANDBOX/work"
  npm exec --yes -- "@neko-catpital-labs/invoker-cli@$VERSION" install
) > "$SANDBOX/install.log" 2>&1 || INSTALL_STATUS=$?
sed 's/^/    /' "$SANDBOX/install.log"
[ "$INSTALL_STATUS" -eq 0 ] || fail "invoker-cli install exited $INSTALL_STATUS (full output above)"

echo "==> reading worker state back through the installed CLI"
TOGGLES_STATUS=0
"$SANDBOX/npm/bin/invoker-cli" worker toggles > "$SANDBOX/toggles.log" 2>&1 || TOGGLES_STATUS=$?
[ "$TOGGLES_STATUS" -eq 0 ] \
  || fail "\`invoker-cli worker toggles\` exited $TOGGLES_STATUS: $(cat "$SANDBOX/toggles.log")"

echo "==> asserting the install landed inside the sandbox"
node "$HERE/lib/assert-install.mjs" \
  --home="$SANDBOX/home" \
  --prefix="$SANDBOX/npm" \
  --config="$INVOKER_REPO_CONFIG_PATH" \
  --transcript="$SANDBOX/install.log" \
  --toggles="$SANDBOX/toggles.log"

echo "==> asserting the install touched nothing on the real machine"
snapshot_host "$SANDBOX/host-after.tsv"
if ! diff -u "$SANDBOX/host-before.tsv" "$SANDBOX/host-after.tsv" > "$SANDBOX/host-diff.txt"; then
  cat "$SANDBOX/host-diff.txt" >&2
  fail "invoker-cli install modified paths outside the sandbox (diff above)"
fi
echo "    unchanged: ${#HOST_WITNESS_PATHS[@]} real-machine paths (harness skill/MCP roots, ~/.invoker, global npm prefix)"

if [ -s "$INVOKER_E2E_TRIPWIRE_LOG" ]; then
  echo "    package-manager calls intercepted by the sandbox:"
  sed 's/^/      /' "$INVOKER_E2E_TRIPWIRE_LOG"
else
  echo "    package-manager calls intercepted by the sandbox: none"
fi

echo "ok invoker-cli install works end to end in a sandbox and leaves the host untouched"
