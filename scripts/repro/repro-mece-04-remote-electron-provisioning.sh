#!/usr/bin/env bash
set -euo pipefail

EXPECT_ISSUE=0
if [[ "${1:-}" == "--expect-issue" ]]; then
  EXPECT_ISSUE=1
  shift
fi
if [[ $# -ne 0 ]]; then
  echo "usage: $0 [--expect-issue]" >&2
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-electron-provision.XXXXXX")"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p \
  "$TMP_DIR/repo/scripts" \
  "$TMP_DIR/repo/packages/app" \
  "$TMP_DIR/repo/node_modules/electron" \
  "$TMP_DIR/repo/node_modules/@electron/get" \
  "$TMP_DIR/repo/node_modules/extract-zip" \
  "$TMP_DIR/no-system-tools"
cp "$ROOT_DIR/scripts/electron.cjs" "$TMP_DIR/repo/scripts/electron.cjs"

cat >"$TMP_DIR/repo/node_modules/electron/package.json" <<'JSON'
{
  "name": "electron",
  "version": "0.0.0-test",
  "main": "index.js"
}
JSON

cat >"$TMP_DIR/repo/node_modules/electron/checksums.json" <<'JSON'
{}
JSON

cat >"$TMP_DIR/repo/node_modules/@electron/get/package.json" <<'JSON'
{
  "name": "@electron/get",
  "version": "0.0.0-test",
  "main": "index.js"
}
JSON

cat >"$TMP_DIR/repo/node_modules/@electron/get/index.js" <<'JS'
exports.downloadArtifact = async function downloadArtifact() {
  return process.env.FAKE_ELECTRON_ARCHIVE;
};
JS

cat >"$TMP_DIR/repo/node_modules/extract-zip/package.json" <<'JSON'
{
  "name": "extract-zip",
  "version": "0.0.0-test",
  "main": "index.js"
}
JSON

cat >"$TMP_DIR/repo/node_modules/extract-zip/index.js" <<'JS'
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function extractElectron(_archivePath, { dir }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'electron'), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });
};
JS

cat >"$TMP_DIR/repo/node_modules/electron/install.js" <<'JS'
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(__dirname, '..', '..', 'installer-ran'), 'yes\n');
if (process.env.FAKE_ELECTRON_INSTALL_SUCCESS === '1') {
  const distDir = path.join(__dirname, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'electron'), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(__dirname, 'path.txt'), 'electron\n');
  process.exit(0);
}
if (process.env.FAKE_ELECTRON_INSTALL_EMPTY_SUCCESS === '1') {
  process.exit(0);
}
console.error('fake Electron installer ran');
process.exit(42);
JS

set +e
(
  cd "$TMP_DIR/repo"
  node scripts/electron.cjs --ensure-only
) >"$TMP_DIR/stdout" 2>"$TMP_DIR/stderr"
STATUS=$?
set -e

INSTALLER_MARKER="$TMP_DIR/repo/installer-ran"

if [[ "$EXPECT_ISSUE" -eq 1 ]]; then
  if [[ "$STATUS" -eq 0 ]]; then
    echo "repro: expected current issue command to fail after installer attempt" >&2
    exit 1
  fi
  if [[ ! -f "$INSTALLER_MARKER" ]]; then
    echo "repro: expected Electron installer to run, but marker is missing" >&2
    echo "--- stderr ---" >&2
    cat "$TMP_DIR/stderr" >&2
    exit 1
  fi
  echo "remote-electron-provisioning issue reproduced: installer was invoked"
  exit 0
fi

if [[ "$STATUS" -eq 0 ]]; then
  echo "repro: expected missing Electron to fail fast" >&2
  exit 1
fi
if [[ -f "$INSTALLER_MARKER" ]]; then
  echo "repro: Electron installer was invoked; remote task startup must only verify provisioning" >&2
  echo "--- stderr ---" >&2
  cat "$TMP_DIR/stderr" >&2
  exit 1
fi
if ! grep -q "Electron is not installed. Provision this machine before running Invoker" "$TMP_DIR/stderr"; then
  echo "repro: missing pre-provisioning error message" >&2
  echo "--- stderr ---" >&2
  cat "$TMP_DIR/stderr" >&2
  exit 1
fi

(
  cd "$TMP_DIR/repo"
  FAKE_ELECTRON_INSTALL_SUCCESS=1 node scripts/electron.cjs --install-only
) >"$TMP_DIR/install-stdout" 2>"$TMP_DIR/install-stderr"
if [[ ! -f "$INSTALLER_MARKER" ]]; then
  echo "repro: install-only did not invoke Electron provisioning" >&2
  echo "--- stderr ---" >&2
  cat "$TMP_DIR/install-stderr" >&2
  exit 1
fi

rm -rf \
  "$TMP_DIR/repo/node_modules/electron/dist" \
  "$TMP_DIR/repo/node_modules/electron/path.txt" \
  "$INSTALLER_MARKER"
NODE_BIN="$(command -v node)"
set +e
(
  cd "$TMP_DIR/repo"
  PATH="$TMP_DIR/no-system-tools" \
    FAKE_ELECTRON_INSTALL_EMPTY_SUCCESS=1 \
    FAKE_ELECTRON_ARCHIVE="$TMP_DIR/fake-electron.zip" \
    "$NODE_BIN" scripts/electron.cjs --install-only
) >"$TMP_DIR/fallback-stdout" 2>"$TMP_DIR/fallback-stderr"
FALLBACK_STATUS=$?
set -e
if [[ "$FALLBACK_STATUS" -ne 0 ]]; then
  echo "repro: Electron fallback must not require a system unzip executable" >&2
  echo "--- stderr ---" >&2
  cat "$TMP_DIR/fallback-stderr" >&2
  exit 1
fi
if [[ ! -x "$TMP_DIR/repo/node_modules/electron/dist/electron" ]]; then
  echo "repro: Electron fallback did not extract the package binary" >&2
  exit 1
fi

echo "remote-electron-provisioning fixed: missing Electron fails without installer"
