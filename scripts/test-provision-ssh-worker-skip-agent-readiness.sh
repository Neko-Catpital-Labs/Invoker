#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/invoker-provision-skip-agent.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

REPO_DIR="$TMP_ROOT/repo"
HOME_DIR="$TMP_ROOT/home"
NODE_INSTALL_DIR="$TMP_ROOT/node-install"
NPM_GLOBAL_PREFIX="$TMP_ROOT/npm-global"
FAKE_BIN="$TMP_ROOT/bin"
PNPM_VERSION="10.31.0"
MISSING_AGENT="missing-agent-cli-for-readiness-test"

mkdir -p \
  "$REPO_DIR/scripts" \
  "$REPO_DIR/node_modules" \
  "$HOME_DIR/.invoker" \
  "$NODE_INSTALL_DIR/bin" \
  "$NPM_GLOBAL_PREFIX/bin" \
  "$FAKE_BIN"

cp "$ROOT/scripts/provision-ssh-worker.sh" "$REPO_DIR/scripts/provision-ssh-worker.sh"
printf '{"private":true}\n' > "$REPO_DIR/package.json"
printf 'lockfileVersion: 9.0\n' > "$REPO_DIR/pnpm-lock.yaml"
ln -s "$(command -v node)" "$NODE_INSTALL_DIR/bin/node"

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

for cmd in git curl jq make g++ unzip ssh; do
  if command -v "$cmd" >/dev/null 2>&1; then
    ln -s "$(command -v "$cmd")" "$FAKE_BIN/$cmd"
  else
    printf '#!/usr/bin/env bash\nexit 0\n' > "$FAKE_BIN/$cmd"
    chmod +x "$FAKE_BIN/$cmd"
  fi
done
ln -s "$(command -v python3)" "$FAKE_BIN/python3"

hash_file() {
  python3 - "$1" <<'PY'
import hashlib, pathlib, sys
print(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest())
PY
}

SCRIPT_HASH="$(hash_file "$REPO_DIR/scripts/provision-ssh-worker.sh")"
LOCK_HASH="$(hash_file "$REPO_DIR/pnpm-lock.yaml")"
NODE_MAJOR="$("$NODE_INSTALL_DIR/bin/node" -p 'process.versions.node.split(".")[0]')"
NODE_VERSION="$("$NODE_INSTALL_DIR/bin/node" --version)"
HOST_STAMP="$HOME_DIR/.invoker/host-provision-stamp"
REPO_STAMP="$REPO_DIR/node_modules/.invoker-ssh-provision-stamp"

printf 'node_major=%s\npnpm=%s\nagents=%s\nscript=%s\n' \
  "$NODE_MAJOR" \
  "$PNPM_VERSION" \
  "$MISSING_AGENT" \
  "$SCRIPT_HASH" > "$HOST_STAMP"

printf 'node=%s\npnpm=%s\nlock=%s\nscript=%s\n' \
  "$NODE_VERSION" \
  "$PNPM_VERSION" \
  "$LOCK_HASH" \
  "$SCRIPT_HASH" > "$REPO_STAMP"

touch -t 200001010000 "$HOST_STAMP"
before_mtime="$(stat -c '%Y' "$HOST_STAMP")"

env \
  HOME="$HOME_DIR" \
  PATH="$FAKE_BIN:$PATH" \
  FAKE_PNPM_VERSION="$PNPM_VERSION" \
  INVOKER_HOME="$HOME_DIR/.invoker" \
  INVOKER_NODE_MAJOR="$NODE_MAJOR" \
  INVOKER_NODE_INSTALL_DIR="$NODE_INSTALL_DIR" \
  INVOKER_NPM_GLOBAL_PREFIX="$NPM_GLOBAL_PREFIX" \
  INVOKER_PNPM_VERSION="$PNPM_VERSION" \
  INVOKER_AGENT_TOOLS="$MISSING_AGENT" \
  INVOKER_SKIP_SYSTEM_PACKAGES=1 \
  INVOKER_SKIP_AGENT_TOOLS=1 \
  INVOKER_SKIP_SHELL_HOOKS=1 \
  bash "$REPO_DIR/scripts/provision-ssh-worker.sh" ensure-repo-ready --repo-dir "$REPO_DIR"

after_mtime="$(stat -c '%Y' "$HOST_STAMP")"
if [[ "$after_mtime" != "$before_mtime" ]]; then
  printf 'FAIL: host_ready checked skipped agent tools and re-ran host bootstrap\n' >&2
  exit 1
fi

printf 'PASS: skipped agent tools are not required for host readiness\n'
