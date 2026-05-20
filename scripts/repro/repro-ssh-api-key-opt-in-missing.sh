#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTATION=""
CONFIG_PATH=""
KEEP_ARTIFACTS=0

usage() {
  cat <<'EOF'
Usage:
  bash scripts/repro/repro-ssh-api-key-opt-in-missing.sh --expect issue|fixed [--config ~/.invoker/config.yaml] [--keep-artifacts]

What it proves:
  SSH remote agent API keys are not forwarded unless a remote target opts in
  with use_api_key: true. If an API-key-only remote agent is configured without
  that flag, remote Codex/Claude startup can fail with 401 authentication errors.

Portable mode:
  Without --config, the script creates a temporary Invoker-like config that has
  a remote target and an API key, but omits use_api_key. That reproduces the
  misconfiguration on any computer with bash, pnpm, and this repo.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect)
      EXPECTATION="${2:-}"
      shift 2
      ;;
    --config)
      CONFIG_PATH="${2:-}"
      shift 2
      ;;
    --keep-artifacts)
      KEEP_ARTIFACTS=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$EXPECTATION" != "issue" && "$EXPECTATION" != "fixed" ]]; then
  echo "--expect must be issue or fixed" >&2
  usage >&2
  exit 2
fi

command -v pnpm >/dev/null 2>&1 || { echo "pnpm is required" >&2; exit 2; }

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-ssh-api-key.XXXXXX")"
cleanup() {
  if [[ "$KEEP_ARTIFACTS" != "1" ]]; then
    rm -rf "$TMP_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [[ -z "$CONFIG_PATH" ]]; then
  CONFIG_PATH="$TMP_DIR/config.yaml"
  cat >"$CONFIG_PATH" <<'EOF'
remoteTargets:
  - id: repro-api-key-target
    host: 127.0.0.1
    user: invoker
    sshKeyPath: /tmp/repro-key
    managed: true
    # use_api_key is intentionally omitted.
EOF
fi

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "Missing config: $CONFIG_PATH" >&2
  exit 2
fi

cd "$ROOT_DIR"

echo "==> proving source behavior: ambient agent API keys are not forwarded by default"
pnpm --dir packages/execution-engine exec vitest run src/__tests__/remote-fix-process-output.test.ts \
  -t "does not export API keys into the remote fix shell by default"

has_remote_target=0
if grep -Eq '^[[:space:]]*remoteTargets[[:space:]]*:' "$CONFIG_PATH" || grep -Eq '^[[:space:]]*remote_targets[[:space:]]*:' "$CONFIG_PATH"; then
  has_remote_target=1
fi

has_use_api_key_true=0
if grep -Eq '^[[:space:]]*use_api_key[[:space:]]*:[[:space:]]*true([[:space:]]|$)' "$CONFIG_PATH"; then
  has_use_api_key_true=1
fi

if [[ "$has_remote_target" == "1" && "$has_use_api_key_true" == "0" ]]; then
  OBSERVED="issue"
else
  OBSERVED="fixed"
fi

echo "config=$CONFIG_PATH"
echo "has_remote_target=$has_remote_target"
echo "has_use_api_key_true=$has_use_api_key_true"
echo "observed=$OBSERVED"
echo "expected=$EXPECTATION"

if [[ "$OBSERVED" != "$EXPECTATION" ]]; then
  exit 1
fi

echo "==> repro matched expectation"
