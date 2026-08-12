#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/invoker-provision-retry.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

REPO_DIR="$TMP_ROOT/repo"
NODE_INSTALL_DIR="$TMP_ROOT/node-install"
FAKE_BIN="$NODE_INSTALL_DIR/bin"
FAKE_PNPM_STATE="$TMP_ROOT/pnpm-attempts"
mkdir -p \
  "$REPO_DIR/scripts" \
  "$REPO_DIR/packages/ui" \
  "$REPO_DIR/packages/app" \
  "$FAKE_BIN" \
  "$TMP_ROOT/home"

cp "$ROOT/scripts/provision-ssh-worker.sh" "$REPO_DIR/scripts/provision-ssh-worker.sh"
printf '{"private":true}\n' > "$REPO_DIR/package.json"
printf 'lockfileVersion: 9.0\n' > "$REPO_DIR/pnpm-lock.yaml"

cat > "$FAKE_BIN/pnpm" <<'FAKE_PNPM'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--version" ]]; then
  printf '%s\n' "$FAKE_PNPM_VERSION"
  exit 0
fi

if [[ "${1:-}" == "--dir" ]]; then
  exit 0
fi

if [[ "${1:-}" != "install" ]]; then
  printf 'unexpected fake pnpm invocation: %s\n' "$*" >&2
  exit 2
fi

attempt=0
if [[ -f "$FAKE_PNPM_STATE" ]]; then
  attempt="$(cat "$FAKE_PNPM_STATE")"
fi
attempt=$((attempt + 1))
printf '%s\n' "$attempt" > "$FAKE_PNPM_STATE"

if [[ "$attempt" -eq 1 ]]; then
  printf 'simulated Electron postinstall RequestError: socket hang up\n' >&2
  exit 1
fi

mkdir -p node_modules packages/app/node_modules/.bin
printf '#!/usr/bin/env bash\nexit 0\n' > packages/app/node_modules/.bin/electron
chmod +x packages/app/node_modules/.bin/electron
FAKE_PNPM
chmod +x "$FAKE_BIN/pnpm"

NODE_BIN="$(command -v node)"
ln -s "$NODE_BIN" "$FAKE_BIN/node"
PNPM_VERSION="$(pnpm --version)"

env \
  HOME="$TMP_ROOT/home" \
  PATH="$FAKE_BIN:$PATH" \
  FAKE_PNPM_STATE="$FAKE_PNPM_STATE" \
  FAKE_PNPM_VERSION="$PNPM_VERSION" \
  INVOKER_HOME="$TMP_ROOT/home/.invoker" \
  INVOKER_NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')" \
  INVOKER_NODE_INSTALL_DIR="$NODE_INSTALL_DIR" \
  INVOKER_PNPM_VERSION="$PNPM_VERSION" \
  INVOKER_PNPM_INSTALL_RETRY_DELAY_SECONDS=0 \
  INVOKER_SKIP_SYSTEM_PACKAGES=1 \
  INVOKER_SKIP_AGENT_TOOLS=1 \
  INVOKER_SKIP_SHELL_HOOKS=1 \
  bash "$REPO_DIR/scripts/provision-ssh-worker.sh" ensure-repo-ready --repo-dir "$REPO_DIR"

attempts="$(cat "$FAKE_PNPM_STATE")"
if [[ "$attempts" != "2" ]]; then
  printf 'FAIL: expected provisioning to recover on attempt 2, saw %s attempts\n' "$attempts" >&2
  exit 1
fi

printf 'PASS: SSH worker provisioning retried pnpm install and recovered on attempt 2\n'
