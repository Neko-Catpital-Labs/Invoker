#!/usr/bin/env bash
set -euo pipefail

EXPECT_ISSUE=0
EXPECT_MISSING_UNZIP_ISSUE=0
if [[ "${1:-}" == "--expect-issue" ]]; then
  EXPECT_ISSUE=1
  shift
elif [[ "${1:-}" == "--expect-missing-unzip-issue" ]]; then
  EXPECT_MISSING_UNZIP_ISSUE=1
  shift
fi
if [[ $# -ne 0 ]]; then
  echo "usage: $0 [--expect-issue|--expect-missing-unzip-issue]" >&2
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE_BIN="$(node -p 'process.execPath')"
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
  "$TMP_DIR/empty-path"
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

cat >"$TMP_DIR/repo/node_modules/electron/install.js" <<'JS'
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(__dirname, '..', '..', 'installer-ran'), 'yes\n');
if (process.env.FAKE_ELECTRON_INSTALL_EMPTY_SUCCESS === '1') {
  process.exit(0);
}
if (process.env.FAKE_ELECTRON_INSTALL_SUCCESS === '1') {
  const distDir = path.join(__dirname, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'electron'), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(__dirname, 'path.txt'), 'electron\n');
  process.exit(0);
}
console.error('fake Electron installer ran');
process.exit(42);
JS

cat >"$TMP_DIR/repo/node_modules/@electron/get/package.json" <<'JSON'
{
  "name": "@electron/get",
  "version": "0.0.0-test",
  "main": "index.js"
}
JSON

cat >"$TMP_DIR/repo/node_modules/@electron/get/index.js" <<'JS'
const fs = require('node:fs');

exports.downloadArtifact = async function downloadArtifact() {
  fs.writeFileSync(process.env.FAKE_ELECTRON_DOWNLOAD_MARKER, 'yes\n');
  return process.env.FAKE_ELECTRON_ZIP;
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

module.exports = async function extractZip(zipPath, options) {
  if (zipPath !== process.env.FAKE_ELECTRON_ZIP) {
    throw new Error(`unexpected Electron archive: ${zipPath}`);
  }
  fs.writeFileSync(process.env.FAKE_EXTRACT_ZIP_MARKER, 'yes\n');
  fs.mkdirSync(options.dir, { recursive: true });
  fs.writeFileSync(path.join(options.dir, 'electron'), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(options.dir, 'electron.d.ts'), 'export {};\n');
};
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

FAKE_ELECTRON_ZIP="$TMP_DIR/electron.zip"
FAKE_ELECTRON_DOWNLOAD_MARKER="$TMP_DIR/repo/electron-download-ran"
FAKE_EXTRACT_ZIP_MARKER="$TMP_DIR/repo/extract-zip-ran"
: >"$FAKE_ELECTRON_ZIP"

set +e
(
  cd "$TMP_DIR/repo"
  PATH="$TMP_DIR/empty-path" \
    FAKE_ELECTRON_INSTALL_EMPTY_SUCCESS=1 \
    FAKE_ELECTRON_ZIP="$FAKE_ELECTRON_ZIP" \
    FAKE_ELECTRON_DOWNLOAD_MARKER="$FAKE_ELECTRON_DOWNLOAD_MARKER" \
    FAKE_EXTRACT_ZIP_MARKER="$FAKE_EXTRACT_ZIP_MARKER" \
    "$NODE_BIN" scripts/electron.cjs --install-only
) >"$TMP_DIR/install-stdout" 2>"$TMP_DIR/install-stderr"
INSTALL_STATUS=$?
set -e

if [[ ! -f "$INSTALLER_MARKER" ]]; then
  echo "repro: install-only did not invoke Electron provisioning" >&2
  echo "--- stderr ---" >&2
  cat "$TMP_DIR/install-stderr" >&2
  exit 1
fi
if [[ ! -f "$FAKE_ELECTRON_DOWNLOAD_MARKER" ]]; then
  echo "repro: Electron fallback did not download the archive" >&2
  echo "--- stderr ---" >&2
  cat "$TMP_DIR/install-stderr" >&2
  exit 1
fi

if [[ "$EXPECT_MISSING_UNZIP_ISSUE" -eq 1 ]]; then
  if [[ "$INSTALL_STATUS" -eq 0 ]]; then
    echo "repro: expected fallback to fail without a host unzip executable" >&2
    exit 1
  fi
  if [[ -f "$FAKE_EXTRACT_ZIP_MARKER" ]]; then
    echo "repro: expected broken fallback not to use extract-zip" >&2
    exit 1
  fi
  echo "remote-electron-provisioning missing-unzip issue reproduced: fallback failed without a host unzip executable"
  exit 0
fi

if [[ "$INSTALL_STATUS" -ne 0 ]]; then
  echo "repro: expected Electron fallback extraction to succeed without a host unzip executable" >&2
  echo "--- stderr ---" >&2
  cat "$TMP_DIR/install-stderr" >&2
  exit 1
fi
if [[ ! -f "$FAKE_EXTRACT_ZIP_MARKER" ]]; then
  echo "repro: repaired fallback did not use extract-zip" >&2
  exit 1
fi
if [[ ! -x "$TMP_DIR/repo/node_modules/electron/dist/electron" ]]; then
  echo "repro: repaired fallback did not leave a usable Electron binary" >&2
  exit 1
fi

echo "remote-electron-provisioning fixed: fallback extraction succeeds without a host unzip executable"

# Regression: a self-hosted CI runner reuses the same on-disk workspace across
# job runs. If a run is killed (job cancellation, timeout-minutes) while
# extract-zip is mid-write, an extraction straight into the live dist/
# directory can leave some files present but not the platform binary --
# resolveInstalledElectronBinary()'s existence-only check must never treat
# that half-written state as installed, and a subsequent install-only must
# never leave dist/ in that half-written shape either.
cat >"$TMP_DIR/repo/node_modules/extract-zip/index.js" <<'JS'
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function extractZip(zipPath, options) {
  if (zipPath !== process.env.FAKE_ELECTRON_ZIP) {
    throw new Error(`unexpected Electron archive: ${zipPath}`);
  }
  fs.writeFileSync(process.env.FAKE_EXTRACT_ZIP_MARKER, 'yes\n');
  fs.mkdirSync(path.join(options.dir, 'locales'), { recursive: true });
  fs.writeFileSync(path.join(options.dir, 'locales', 'en-US.pak'), 'fake-locale-data');
  throw new Error('simulated interruption: killed mid-extraction before the platform binary was written');
};
JS

rm -f "$TMP_DIR/repo/installer-ran" "$FAKE_ELECTRON_DOWNLOAD_MARKER" "$FAKE_EXTRACT_ZIP_MARKER"
rm -rf "$TMP_DIR/repo/node_modules/electron/dist" "$TMP_DIR/repo/node_modules/electron/path.txt"
PLATFORM_BINARY_PATH="$("$NODE_BIN" -e "
switch (process.platform) {
  case 'mas':
  case 'darwin':
    console.log('Electron.app/Contents/MacOS/Electron');
    break;
  case 'win32':
    console.log('electron.exe');
    break;
  default:
    console.log('electron');
}
")"

set +e
(
  cd "$TMP_DIR/repo"
  PATH="$TMP_DIR/empty-path" \
    FAKE_ELECTRON_INSTALL_EMPTY_SUCCESS=1 \
    FAKE_ELECTRON_ZIP="$FAKE_ELECTRON_ZIP" \
    FAKE_ELECTRON_DOWNLOAD_MARKER="$FAKE_ELECTRON_DOWNLOAD_MARKER" \
    FAKE_EXTRACT_ZIP_MARKER="$FAKE_EXTRACT_ZIP_MARKER" \
    "$NODE_BIN" scripts/electron.cjs --install-only
) >"$TMP_DIR/interrupted-install-stdout" 2>"$TMP_DIR/interrupted-install-stderr"
INTERRUPTED_STATUS=$?
set -e

if [[ "$INTERRUPTED_STATUS" -eq 0 ]]; then
  echo "repro: expected install-only to fail after an interrupted extraction" >&2
  echo "--- stderr ---" >&2
  cat "$TMP_DIR/interrupted-install-stderr" >&2
  exit 1
fi
if [[ -e "$TMP_DIR/repo/node_modules/electron/dist" ]] && [[ ! -e "$TMP_DIR/repo/node_modules/electron/dist/$PLATFORM_BINARY_PATH" ]]; then
  echo "repro: an interrupted extraction left a half-written dist/ (has locales/ but not the platform binary) -- this is the corrupted state observed on the real CI fleet" >&2
  find "$TMP_DIR/repo/node_modules/electron/dist" >&2
  exit 1
fi

echo "remote-electron-provisioning interrupted-extraction fixed: a killed extraction never leaves a half-written dist/"
