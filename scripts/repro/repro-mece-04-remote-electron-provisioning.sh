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

# scripts/electron.cjs's repair path (repairElectronWithPackageExtractor) does
# its own zip extraction with fs.readSync + zlib.inflateRawSync instead of a
# third-party unzip library, so these fixtures are real (if tiny) zip
# archives -- built by hand here -- rather than a stub extraction module.
cat >"$TMP_DIR/make-test-zip.cjs" <<'JS'
const fs = require('node:fs');
const zlib = require('node:zlib');

const [, , outPath, specPath] = process.argv;
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

const localParts = [];
const centralParts = [];
let offset = 0;

for (const entry of spec.entries) {
  const nameBuf = Buffer.from(entry.name, 'utf8');
  const uncompressed = Buffer.from(entry.data ?? '', 'utf8');
  const compressed = entry.corrupt
    ? Buffer.from('not a valid deflate stream, this is deliberately garbage bytes', 'utf8')
    : zlib.deflateRawSync(uncompressed);
  const method = 8;

  const localHeader = Buffer.concat([
    u32(0x04034b50),
    u16(20),
    u16(0),
    u16(method),
    u16(0),
    u16(0x21),
    u32(0),
    u32(compressed.length),
    u32(uncompressed.length),
    u16(nameBuf.length),
    u16(0),
    nameBuf,
  ]);
  localParts.push(localHeader, compressed);

  const unixMode = (entry.mode ?? 0o644) | 0o100000;
  const externalAttrs = (unixMode * 0x10000) >>> 0;

  const centralEntry = Buffer.concat([
    u32(0x02014b50),
    u16((3 << 8) | 20),
    u16(20),
    u16(0),
    u16(method),
    u16(0),
    u16(0x21),
    u32(0),
    u32(compressed.length),
    u32(uncompressed.length),
    u16(nameBuf.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(externalAttrs),
    u32(offset),
    nameBuf,
  ]);
  centralParts.push(centralEntry);

  offset += localHeader.length + compressed.length;
}

const centralDirectoryOffset = offset;
const centralDirectory = Buffer.concat(centralParts);
const eocd = Buffer.concat([
  u32(0x06054b50),
  u16(0),
  u16(0),
  u16(spec.entries.length),
  u16(spec.entries.length),
  u32(centralDirectory.length),
  u32(centralDirectoryOffset),
  u16(0),
]);

fs.writeFileSync(outPath, Buffer.concat([...localParts, centralDirectory, eocd]));
JS

cat >"$TMP_DIR/success-spec.json" <<'JSON'
{"entries": [
  {"name": "electron.d.ts", "data": "export {};\n", "mode": 420},
  {"name": "electron", "data": "#!/usr/bin/env sh\nexit 0\n", "mode": 493}
]}
JSON
"$NODE_BIN" "$TMP_DIR/make-test-zip.cjs" "$TMP_DIR/electron-success.zip" "$TMP_DIR/success-spec.json"

FAKE_ELECTRON_ZIP="$TMP_DIR/electron-success.zip"
FAKE_ELECTRON_DOWNLOAD_MARKER="$TMP_DIR/repo/electron-download-ran"

set +e
(
  cd "$TMP_DIR/repo"
  PATH="$TMP_DIR/empty-path" \
    FAKE_ELECTRON_INSTALL_EMPTY_SUCCESS=1 \
    FAKE_ELECTRON_ZIP="$FAKE_ELECTRON_ZIP" \
    FAKE_ELECTRON_DOWNLOAD_MARKER="$FAKE_ELECTRON_DOWNLOAD_MARKER" \
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
if [[ "$INSTALL_STATUS" -ne 0 ]]; then
  echo "repro: expected Electron fallback extraction to succeed without a third-party unzip library" >&2
  echo "--- stderr ---" >&2
  cat "$TMP_DIR/install-stderr" >&2
  exit 1
fi
if [[ ! -x "$TMP_DIR/repo/node_modules/electron/dist/electron" ]]; then
  echo "repro: repaired fallback did not leave a usable, executable Electron binary" >&2
  exit 1
fi

echo "remote-electron-provisioning fixed: fallback extraction succeeds without a third-party unzip library"

# Regression: a self-hosted CI runner reuses the same on-disk workspace across
# job runs. If a run is killed (job cancellation, timeout-minutes) or an
# archive is truncated/corrupted while the fallback is mid-write, an
# extraction straight into the live dist/ directory can leave some files
# present but not the platform binary -- resolveInstalledElectronBinary()'s
# existence-only check must never treat that half-written state as installed,
# and a subsequent install-only must never leave dist/ in that half-written
# shape either. This is also the exact corrupted-state signature observed on
# the real CI fleet: a dist/locales/ directory with a lone, truncated locale
# file and no platform binary.
cat >"$TMP_DIR/interrupted-spec.json" <<'JSON'
{"entries": [
  {"name": "locales/en-US.pak", "data": "fake-locale-data", "mode": 420},
  {"name": "electron", "corrupt": true, "mode": 493}
]}
JSON
"$NODE_BIN" "$TMP_DIR/make-test-zip.cjs" "$TMP_DIR/electron-interrupted.zip" "$TMP_DIR/interrupted-spec.json"

FAKE_ELECTRON_ZIP="$TMP_DIR/electron-interrupted.zip"
rm -f "$TMP_DIR/repo/installer-ran" "$FAKE_ELECTRON_DOWNLOAD_MARKER"
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
