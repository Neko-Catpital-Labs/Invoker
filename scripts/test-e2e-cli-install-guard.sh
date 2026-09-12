#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GUARD="$ROOT/scripts/e2e-cli-install/lib/sandbox-guard.sh"
[ -f "$GUARD" ] || { echo "FAIL: missing $GUARD" >&2; exit 1; }

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/invoker-guard-test.XXXXXX")"
OUTSIDE="$(mktemp -d "${TMPDIR:-/tmp}/invoker-guard-outside.XXXXXX")"
trap 'rm -rf "$SCRATCH" "$OUTSIDE"' EXIT

REAL_HOME="$HOME"
mkdir -p "$SCRATCH/home" "$SCRATCH/npm" "$SCRATCH/db" "$SCRATCH/bin"
for tool in brew apt-get sudo; do
  printf '#!/usr/bin/env bash\nexit 127\n' > "$SCRATCH/bin/$tool"
  chmod +x "$SCRATCH/bin/$tool"
done

FAILURES=0
run_case() {
  local name="$1" expect="$2" expect_text="$3"
  shift 3
  local out status
  out="$("$@" 2>&1)"
  status=$?
  if [ "$status" != "$expect" ]; then
    echo "FAIL  $name: expected exit $expect, got $status"
    echo "      output: $out"
    FAILURES=$((FAILURES + 1))
    return
  fi
  if [ -n "$expect_text" ] && ! printf '%s' "$out" | grep -qF "$expect_text"; then
    echo "FAIL  $name: exit $status was right but output never said \"$expect_text\""
    echo "      output: $out"
    FAILURES=$((FAILURES + 1))
    return
  fi
  echo "ok    $name"
}

guard_with() {
  env -i \
    PATH="$SCRATCH/bin:$PATH" \
    TMPDIR="${TMPDIR:-/tmp}" \
    "$@" \
    bash -c ". '$GUARD'; invoker_sandbox_assert_safe '$SCRATCH' '$REAL_HOME'"
}

SAFE_ENV=(
  "HOME=$SCRATCH/home"
  "npm_config_prefix=$SCRATCH/npm"
  "INVOKER_DB_DIR=$SCRATCH/db"
  "INVOKER_REPO_CONFIG_PATH=$SCRATCH/home/.invoker/config.json"
  "INVOKER_E2E_TRIPWIRE_LOG=$SCRATCH/tripwire.log"
)

run_case "a fully redirected sandbox is allowed" 0 "sandbox guard: ok" \
  guard_with "${SAFE_ENV[@]}"

run_case "the real HOME is refused" 78 "HOME resolves to" \
  guard_with "HOME=$REAL_HOME" "npm_config_prefix=$SCRATCH/npm" \
    "INVOKER_DB_DIR=$SCRATCH/db" "INVOKER_REPO_CONFIG_PATH=$SCRATCH/home/.invoker/config.json" \
    "INVOKER_E2E_TRIPWIRE_LOG=$SCRATCH/tripwire.log"

run_case "a global npm prefix outside the sandbox is refused" 78 "npm_config_prefix resolves to" \
  guard_with "HOME=$SCRATCH/home" "npm_config_prefix=$OUTSIDE" \
    "INVOKER_DB_DIR=$SCRATCH/db" "INVOKER_REPO_CONFIG_PATH=$SCRATCH/home/.invoker/config.json" \
    "INVOKER_E2E_TRIPWIRE_LOG=$SCRATCH/tripwire.log"

run_case "an unset INVOKER_DB_DIR is refused as UNCHECKED, not passed" 78 "INVOKER_DB_DIR is unset" \
  guard_with "HOME=$SCRATCH/home" "npm_config_prefix=$SCRATCH/npm" \
    "INVOKER_REPO_CONFIG_PATH=$SCRATCH/home/.invoker/config.json" \
    "INVOKER_E2E_TRIPWIRE_LOG=$SCRATCH/tripwire.log"

run_case "an unset tripwire log is refused as UNCHECKED, not passed" 78 "INVOKER_E2E_TRIPWIRE_LOG is unset" \
  guard_with "HOME=$SCRATCH/home" "npm_config_prefix=$SCRATCH/npm" \
    "INVOKER_DB_DIR=$SCRATCH/db" "INVOKER_REPO_CONFIG_PATH=$SCRATCH/home/.invoker/config.json"

mkdir -p "$OUTSIDE/bin"
printf '#!/usr/bin/env bash\nexit 0\n' > "$OUTSIDE/bin/brew"
chmod +x "$OUTSIDE/bin/brew"
run_case "a real brew ahead of the tripwire is refused" 78 "system package manager" \
  env -i PATH="$OUTSIDE/bin:$SCRATCH/bin:$PATH" TMPDIR="${TMPDIR:-/tmp}" "${SAFE_ENV[@]}" \
    bash -c ". '$GUARD'; invoker_sandbox_assert_safe '$SCRATCH' '$REAL_HOME'"

mkdir -p "$SCRATCH/nonpm"
for tool in bash dirname basename; do
  resolved="$(command -v "$tool")" || { echo "FAIL: $tool is not on PATH" >&2; exit 1; }
  ln -sf "$resolved" "$SCRATCH/nonpm/$tool"
done
if env -i PATH="$SCRATCH/nonpm" "$SCRATCH/nonpm/bash" -c 'command -v npm' >/dev/null 2>&1; then
  echo "FAIL  an npm-free PATH could not be constructed, so the UNCHECKED case is itself UNCHECKED"
  FAILURES=$((FAILURES + 1))
else
  run_case "an npm that cannot be found is refused as UNCHECKED" 78 "npm is not on PATH" \
    env -i PATH="$SCRATCH/nonpm" TMPDIR="${TMPDIR:-/tmp}" "${SAFE_ENV[@]}" \
      bash -c ". '$GUARD'; invoker_sandbox_assert_safe '$SCRATCH' '$REAL_HOME'"
fi

if [ "$FAILURES" -gt 0 ]; then
  echo "FAIL: $FAILURES sandbox-guard case(s) failed" >&2
  exit 1
fi
echo "ok sandbox guard refuses every unsafe redirect and allows the safe one"
