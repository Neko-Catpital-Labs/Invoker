#!/usr/bin/env bash
# Install bundled Invoker skills into local agent skill directories.
# Safe to run repeatedly. Installs prefixed copies such as invoker-plan-to-invoker.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

INVOKER_SKILL_CATEGORY="${INVOKER_SKILL_CATEGORY:-}"
OWNER_STOP_WAIT_SECONDS=15

log() {
  echo "[setup] $*"
}

fail() {
  echo "[setup] error: $*" >&2
  exit 1
}

check_required_commands() {
  local missing=()
  local required=(git node pnpm)
  for cmd in "${required[@]}"; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      missing+=("$cmd")
    fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    fail "missing required command(s): ${missing[*]}"
  fi
  log "Core tools present: git, node, pnpm"
}

build_headless_installer() {
  log "Checking shared shell policy..."
  pnpm --filter @invoker/shell test

  log "Building bundled invoker-cli artifact..."
  pnpm --filter @invoker/cli build

  log "Building headless app runtime..."
  pnpm --filter @invoker/app build
}

resolve_checkout_db_path() {
  node --input-type=module <<'EOF'
import { resolveInvokerInstanceProfile, resolveRepoRoot } from './packages/contracts/dist/index.js';

const sourceRoot = resolveRepoRoot(process.cwd());
const profile = resolveInvokerInstanceProfile({
  kind: 'source-development',
  sourceRoot,
  env: process.env,
  homeDir: process.env.HOME,
});
process.stdout.write(`${profile.homeRoot}/invoker.db`);
EOF
}

pid_is_alive() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

wait_for_pid_exit() {
  local pid="$1"
  local waited=0
  while [ "$waited" -lt "$OWNER_STOP_WAIT_SECONDS" ]; do
    pid_is_alive "$pid" || return 0
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

remove_stale_db_lock() {
  local lock_dir="$1"
  local pid=""
  [ -d "$lock_dir" ] || return 0
  pid="$(cat "${lock_dir}/pid" 2>/dev/null || true)"
  if pid_is_alive "$pid"; then
    return 1
  fi
  rm -rf "$lock_dir"
  return 0
}

stop_checkout_db_owner() {
  local db_path lock_dir pid
  db_path="$(resolve_checkout_db_path)" || fail "could not resolve this checkout's Invoker DB path"
  lock_dir="${db_path}.lock"

  if [ ! -f "${lock_dir}/pid" ]; then
    log "No writer lock at ${lock_dir}; continuing"
    return 0
  fi

  pid="$(cat "${lock_dir}/pid" 2>/dev/null || true)"
  if ! pid_is_alive "$pid"; then
    log "Removing stale DB lock at ${lock_dir}"
    rm -rf "$lock_dir"
    return 0
  fi

  log "Stopping local owner PID ${pid} holding ${db_path}"
  kill -TERM "$pid" 2>/dev/null || true
  if ! wait_for_pid_exit "$pid"; then
    log "Owner PID ${pid} still alive after ${OWNER_STOP_WAIT_SECONDS}s; sending SIGKILL"
    kill -KILL "$pid" 2>/dev/null || true
    wait_for_pid_exit "$pid" || true
  fi

  if ! remove_stale_db_lock "$lock_dir"; then
    fail "could not stop owner PID ${pid} holding ${db_path}"
  fi
  log "Local owner stopped; writer lock free"
}

install_bundled_skills() {
  local mode="${1:-reinstall}"
  stop_checkout_db_owner
  log "Installing bundled Invoker skills with prefix invoker-..."
  unset ELECTRON_RUN_AS_NODE
  if [ -n "$INVOKER_SKILL_CATEGORY" ]; then
    node scripts/electron.cjs packages/app/dist/main.js --headless install-skills "$mode" "$INVOKER_SKILL_CATEGORY"
  else
    node scripts/electron.cjs packages/app/dist/main.js --headless install-skills "$mode"
  fi
}

check_required_commands
build_headless_installer
install_bundled_skills "${1:-reinstall}"
log "Setup complete."
