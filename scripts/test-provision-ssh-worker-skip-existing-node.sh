#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/invoker-provision-existing-node.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

REPO_DIR="$TMP_ROOT/repo"
HOME_DIR="$TMP_ROOT/home"
NODE_INSTALL_DIR="$TMP_ROOT/node-install"
NPM_GLOBAL_PREFIX="$TMP_ROOT/npm-global"
FAKE_BIN="$TMP_ROOT/bin"
CALL_MARKER="$TMP_ROOT/download-attempted"
PNPM_VERSION="10.31.0"

mkdir -p \
  "$REPO_DIR/scripts" \
  "$REPO_DIR/node_modules" \
  "$HOME_DIR/.invoker" \
  "$NPM_GLOBAL_PREFIX/bin" \
  "$FAKE_BIN"

cp "$ROOT/scripts/provision-ssh-worker.sh" "$REPO_DIR/scripts/provision-ssh-worker.sh"
printf '{"private":true}\n' > "$REPO_DIR/package.json"
printf 'lockfileVersion: 9.0\n' > "$REPO_DIR/pnpm-lock.yaml"
ln -s "$(command -v node)" "$FAKE_BIN/node"
ln -s "$(command -v python3)" "$FAKE_BIN/python3"

cat > "$NPM_GLOBAL_PREFIX/bin/pnpm" <<'FAKE_PNPM'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "--version" ]]; then
  printf '%s\n' "$FAKE_PNPM_VERSION"
  exit 0
fi
printf 'unexpected fake pnpm invocation: %s\n' "$*" >&2
exit 2
FAKE_PNPM
chmod +x "$NPM_GLOBAL_PREFIX/bin/pnpm"

cat > "$FAKE_BIN/curl" <<FAKE_CURL
#!/usr/bin/env bash
printf 'curl should not run when matching Node is already on PATH\n' >&2
touch "$CALL_MARKER"
exit 42
FAKE_CURL
chmod +x "$FAKE_BIN/curl"

cat > "$FAKE_BIN/tar" <<FAKE_TAR
#!/usr/bin/env bash
printf 'tar should not run when matching Node is already on PATH\n' >&2
touch "$CALL_MARKER"
exit 42
FAKE_TAR
chmod +x "$FAKE_BIN/tar"

hash_file() {
  python3 - "$1" <<'PY'
import hashlib, pathlib, sys
print(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest())
PY
}

SCRIPT_HASH="$(hash_file "$REPO_DIR/scripts/provision-ssh-worker.sh")"
LOCK_HASH="$(hash_file "$REPO_DIR/pnpm-lock.yaml")"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_VERSION="$(node --version)"
REPO_STAMP="$REPO_DIR/node_modules/.invoker-ssh-provision-stamp"

printf 'node=%s\npnpm=%s\nlock=%s\nscript=%s\n' \
  "$NODE_VERSION" \
  "$PNPM_VERSION" \
  "$LOCK_HASH" \
  "$SCRIPT_HASH" > "$REPO_STAMP"

env \
  HOME="$HOME_DIR" \
  PATH="$FAKE_BIN:$PATH" \
  FAKE_PNPM_VERSION="$PNPM_VERSION" \
  INVOKER_HOME="$HOME_DIR/.invoker" \
  INVOKER_NODE_MAJOR="$NODE_MAJOR" \
  INVOKER_NODE_INSTALL_DIR="$NODE_INSTALL_DIR" \
  INVOKER_NPM_GLOBAL_PREFIX="$NPM_GLOBAL_PREFIX" \
  INVOKER_PNPM_VERSION="$PNPM_VERSION" \
  INVOKER_SKIP_SYSTEM_PACKAGES=1 \
  INVOKER_SKIP_AGENT_TOOLS=1 \
  INVOKER_SKIP_SHELL_HOOKS=1 \
  bash "$REPO_DIR/scripts/provision-ssh-worker.sh" ensure-repo-ready --repo-dir "$REPO_DIR"

if [[ -e "$CALL_MARKER" ]]; then
  printf 'FAIL: provisioning tried to download and unpack Node despite matching Node on PATH\n' >&2
  exit 1
fi

if [[ -e "$NODE_INSTALL_DIR/bin/node" ]]; then
  printf 'FAIL: provisioning installed managed Node instead of using PATH Node\n' >&2
  exit 1
fi

printf 'PASS: skipped system packages reuse matching Node from PATH\n'
