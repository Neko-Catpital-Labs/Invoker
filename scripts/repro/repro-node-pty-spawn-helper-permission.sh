#!/usr/bin/env bash
set -euo pipefail

# Proves node-pty's macOS spawn-helper execute bit is required for PTY spawn.
# The script copies the installed node-pty package to a temp directory so it
# never mutates the repo's node_modules.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="$ROOT/packages/app"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-node-pty-repro.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

NODE_PTY_DIR="$(
  cd "$APP_DIR"
  node - <<'NODE'
const path = require('node:path');
const entry = require.resolve('node-pty');
console.log(path.dirname(path.dirname(entry)));
NODE
)"

COPY_DIR="$TMP_DIR/node-pty"
cp -R "$NODE_PTY_DIR" "$COPY_DIR"

HELPER="$COPY_DIR/prebuilds/$(node -p '`${process.platform}-${process.arch}`')/spawn-helper"
if [[ ! -f "$HELPER" ]]; then
  echo "SKIP: no spawn-helper for $(node -p '`${process.platform}-${process.arch}`')" >&2
  exit 0
fi

run_spawn() {
  local mode_label="$1"
  NODE_PTY_COPY="$COPY_DIR" node - <<'NODE'
const pty = require(process.env.NODE_PTY_COPY);
try {
  const term = pty.spawn('/bin/sh', ['-lc', 'printf ok'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: process.env,
  });
  let output = '';
  term.onData((data) => { output += data; });
  term.onExit((event) => {
    console.log(JSON.stringify({ ok: true, output, exitCode: event.exitCode }));
  });
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 42;
}
NODE
  local status=$?
  echo "spawn status with $mode_label helper: $status"
  return "$status"
}

chmod 0644 "$HELPER"
echo "helper mode after chmod 0644: $(stat -f '%Lp %N' "$HELPER" 2>/dev/null || stat -c '%a %n' "$HELPER")"
if run_spawn "0644"; then
  echo "FAIL: spawn unexpectedly succeeded with non-executable spawn-helper" >&2
  exit 1
fi

chmod 0755 "$HELPER"
echo "helper mode after chmod 0755: $(stat -f '%Lp %N' "$HELPER" 2>/dev/null || stat -c '%a %n' "$HELPER")"
run_spawn "0755"

echo "PASS: node-pty spawn fails when spawn-helper is non-executable and succeeds when executable"
