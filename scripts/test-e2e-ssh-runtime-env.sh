#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_TMPDIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-e2e-ssh-runtime-env.XXXXXX")"
trap 'rm -rf "$TEST_TMPDIR"' EXIT

# shellcheck disable=SC1091
source "$ROOT/scripts/e2e-ssh/lib/ssh-common.sh"

_INVOKER_E2E_SSH_REMOTE_HOME="$TEST_TMPDIR/remote-home"
_INVOKER_E2E_SSH_TAG="runtime-env-test"
mkdir -p "$_INVOKER_E2E_SSH_REMOTE_HOME"

invoker_e2e_ssh_run() {
  bash -c "$1"
}

expected_cache="$TEST_TMPDIR/electron-cache"
electron_config_cache="$expected_cache" invoker_e2e_ssh_install_login_path

env_file="$_INVOKER_E2E_SSH_REMOTE_HOME/env.sh"
grep -F "# invoker-e2e-ssh-runtime-env ${_INVOKER_E2E_SSH_TAG}" "$env_file" >/dev/null
grep -F "export electron_config_cache=\"$expected_cache\"" "$env_file" >/dev/null

unset electron_config_cache
case "$(uname -s)" in
  Darwin) expected_default_cache="$HOME/Library/Caches/electron" ;;
  *) expected_default_cache="${XDG_CACHE_HOME:-$HOME/.cache}/electron" ;;
esac
test "$(invoker_e2e_electron_cache_dir)" = "$expected_default_cache"

invoker_e2e_ssh_prune_login_path_file "$env_file"
if grep -Fq "invoker-e2e-ssh-runtime-env" "$env_file" || grep -Fq 'export electron_config_cache=' "$env_file"; then
  echo "FAIL: SSH runtime environment cleanup left tagged exports behind" >&2
  exit 1
fi

echo "PASS: SSH runtime environment forwards and cleans the Electron cache"
