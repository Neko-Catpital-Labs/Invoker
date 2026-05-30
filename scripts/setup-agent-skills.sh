#!/usr/bin/env bash
# Install bundled Invoker skills into local agent skill directories.
# Safe to run repeatedly. Installs prefixed copies such as invoker-plan-to-invoker.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

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
  log "Building bundled invoker-cli artifact..."
  pnpm --filter @invoker/cli build

  log "Building headless app runtime..."
  pnpm --filter @invoker/app build
}

install_bundled_skills() {
  local mode="${1:-reinstall}"
  log "Installing bundled Invoker skills with prefix invoker-..."
  unset ELECTRON_RUN_AS_NODE
  node scripts/electron.cjs packages/app/dist/main.js --headless install-skills "$mode"
}

check_required_commands
build_headless_installer
install_bundled_skills "${1:-reinstall}"
log "Setup complete."
