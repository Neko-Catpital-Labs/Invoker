#!/usr/bin/env bash
# E2E: prove the Mac DMG install auto-installs and auto-updates invoker-cli.
# Mounts the locally built DMG, copies Invoker.app out (a real DMG install),
# launches it with INVOKER_CLI_INSTALL_DIR pointed at a scratch dir (keeps the
# test hermetic — no writes to /usr/local/bin), and asserts:
#   1. fresh launch installs invoker-cli at the app version
#   2. an outdated invoker-cli is auto-updated on the next launch
#
# Usage: bash scripts/e2e-dmg-cli-install.sh
#   Expects release/Invoker-<version>-<arch>.dmg to exist
#   (built by scripts/e2e-npm-cli-install.sh or `pnpm run dist:desktop:mac`).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This e2e script exercises the macOS DMG; run it on a Mac." >&2
  exit 64
fi

VERSION="$(node -p "require('./packages/app/package.json').version")"
ARCH="$(node -p "process.arch")"
DMG="release/Invoker-$VERSION-$ARCH.dmg"
[ -f "$DMG" ] || { echo "Missing $DMG — build it first (pnpm run dist:desktop:mac:$ARCH)." >&2; exit 1; }

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/invoker-e2e-dmg.XXXXXX")"
MOUNT_POINT="$SCRATCH/mnt"
APP_DIR="$SCRATCH/Applications"
BIN_DIR="$SCRATCH/bin"
APP_PID=""

cleanup() {
  # The app spawns children (e.g. a `--headless owner-serve` daemon); kill by
  # scratch path so nothing outlives the test.
  pkill -f "$(basename "$SCRATCH")" 2>/dev/null || true
  hdiutil detach "$MOUNT_POINT" >/dev/null 2>&1 || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $1" >&2
  if [ -f "$SCRATCH/app.log" ]; then
    echo "--- app stdout/stderr (tail):" >&2
    tail -20 "$SCRATCH/app.log" >&2
  fi
  if [ -f "$SCRATCH/db/invoker.log" ]; then
    echo "--- invoker.log (tail):" >&2
    tail -20 "$SCRATCH/db/invoker.log" >&2
  fi
  exit 1
}

# 1. "Install" the DMG: mount, copy Invoker.app out, unmount.
mkdir -p "$MOUNT_POINT" "$APP_DIR" "$SCRATCH/home" "$SCRATCH/user-data" "$SCRATCH/db" "$BIN_DIR"
hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MOUNT_POINT" >/dev/null
cp -R "$MOUNT_POINT/Invoker.app" "$APP_DIR/"
hdiutil detach "$MOUNT_POINT" >/dev/null
APP_BINARY="$APP_DIR/Invoker.app/Contents/MacOS/Invoker"
[ -x "$APP_BINARY" ] || fail "DMG did not contain a launchable Invoker.app"

launch_app() {
  # HOME + INVOKER_USER_DATA_DIR + INVOKER_DB_DIR keep the test instance fully
  # isolated: its own Electron userData (and single-instance lock, so it can
  # run alongside a normally running Invoker), its own DB, no writes to the
  # real home.
  HOME="$SCRATCH/home" \
  INVOKER_USER_DATA_DIR="$SCRATCH/user-data" \
  INVOKER_CLI_INSTALL_DIR="$BIN_DIR" \
  INVOKER_DB_DIR="$SCRATCH/db" \
    "$APP_BINARY" >"$SCRATCH/app.log" 2>&1 &
  APP_PID=$!
}

quit_app() {
  kill "$APP_PID" 2>/dev/null || true
  wait "$APP_PID" 2>/dev/null || true
  APP_PID=""
  # Also reap app-spawned children (daemon owner, helpers) between phases.
  pkill -f "$(basename "$SCRATCH")" 2>/dev/null || true
}

wait_for_cli_version() {
  local expected="$1"
  for _ in $(seq 1 60); do
    if [ -x "$BIN_DIR/invoker-cli" ]; then
      local actual
      actual="$("$BIN_DIR/invoker-cli" --version 2>/dev/null || true)"
      [ "$actual" = "$expected" ] && return 0
    fi
    sleep 1
  done
  return 1
}

# 2. Fresh-install case: launch with no invoker-cli present.
launch_app
wait_for_cli_version "$VERSION" \
  || fail "fresh launch did not install invoker-cli $VERSION into $BIN_DIR within 60s"
quit_app
echo "ok fresh DMG launch installed invoker-cli $VERSION"

# 3. Update case: seed an outdated invoker-cli, relaunch, expect overwrite.
cat > "$BIN_DIR/invoker-cli" <<'FAKE'
#!/usr/bin/env bash
echo "0.0.1"
FAKE
chmod 755 "$BIN_DIR/invoker-cli"
[ "$("$BIN_DIR/invoker-cli" --version)" = "0.0.1" ] || fail "could not seed the outdated fake cli"

launch_app
wait_for_cli_version "$VERSION" \
  || fail "relaunch did not auto-update outdated invoker-cli to $VERSION within 60s"
quit_app
echo "ok relaunch auto-updated outdated invoker-cli to $VERSION"
