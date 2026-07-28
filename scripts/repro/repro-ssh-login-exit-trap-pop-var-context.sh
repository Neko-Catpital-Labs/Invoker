#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIG_PATH="${INVOKER_CONFIG_PATH:-$HOME/.invoker/config.json}"
TARGET_ID="${INVOKER_DO1_TARGET_ID:-remote_digital_ocean_1}"
SSH_CONNECT_TIMEOUT="${INVOKER_SSH_TIMEOUT:-10}"

resolve_target() {
  node - "$CONFIG_PATH" "$TARGET_ID" <<'NODE'
const fs = require('node:fs');
const os = require('node:os');
const [configPath, targetId] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const target = config.remoteTargets?.[targetId];
if (!target?.host || !target?.user || !target?.sshKeyPath) process.exit(2);
const expandHome = (value) => value.startsWith('~/') ? `${os.homedir()}/${value.slice(2)}` : value;
process.stdout.write([target.host, target.user, expandHome(target.sshKeyPath)].join('\t'));
NODE
}

[[ -f "$CONFIG_PATH" ]] || { echo "missing config: $CONFIG_PATH" >&2; exit 1; }
IFS=$'\t' read -r HOST USER SSH_KEY <<<"$(resolve_target)"
[[ -r "$SSH_KEY" ]] || { echo "ssh key not readable: $SSH_KEY" >&2; exit 1; }

run_remote() {
  local mode="$1"
  local body="$2"
  local body_b64
  body_b64="$(printf '%s' "$body" | base64)"
  ssh -i "$SSH_KEY" \
    -o StrictHostKeyChecking=accept-new \
    -o BatchMode=yes \
    -o ConnectTimeout="$SSH_CONNECT_TIMEOUT" \
    "$USER@$HOST" "BODY_B64='$body_b64' bash $mode -s" <<'REMOTE'
set -euo pipefail
printf 'BASH_VERSION=%s\n' "$BASH_VERSION"
BODY="$(printf '%s' "$BODY_B64" | base64 -d)"
eval "$BODY"
REMOTE
}

FAIL_LOG="$(mktemp "${TMPDIR:-/tmp}/invoker-pop-var-fail.XXXXXX")"
PASS_LOG="$(mktemp "${TMPDIR:-/tmp}/invoker-pop-var-pass.XXXXXX")"
cleanup() {
  rm -f "$FAIL_LOG" "$PASS_LOG"
}
trap cleanup EXIT

FAIL_BODY="$(cat <<'EOF'
cleanup_runtime() {
  trap - EXIT HUP INT TERM
  exit "$1"
}
trap 'cleanup_runtime "$?"' EXIT
echo before-cleanup
EOF
)"
PASS_BODY="$(cat <<'EOF'
cleanup_runtime() {
  trap - EXIT HUP INT TERM
}
trap 'cleanup_runtime' EXIT
echo after-fix
EOF
)"

set +e
run_remote '-l' "$FAIL_BODY" >"$FAIL_LOG" 2>&1
FAIL_RC=$?
set -e
cat "$FAIL_LOG"
if [[ "$FAIL_RC" -eq 0 ]]; then
  echo "expected login-shell repro to fail" >&2
  exit 1
fi
grep -q 'pop_var_context' "$FAIL_LOG" || {
  echo "expected pop_var_context in failing repro" >&2
  exit 1
}

run_remote '-l' "$PASS_BODY" >"$PASS_LOG" 2>&1
cat "$PASS_LOG"
grep -q 'after-fix' "$PASS_LOG" || {
  echo "expected fixed repro to print after-fix" >&2
  exit 1
}
if grep -q 'pop_var_context' "$PASS_LOG"; then
  echo "fixed repro still hit pop_var_context" >&2
  exit 1
fi

echo "ok root cause reproduced and fixed on $TARGET_ID ($USER@$HOST)"
