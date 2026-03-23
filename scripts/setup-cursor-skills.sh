#!/usr/bin/env bash
# Bootstrap local Invoker prerequisites and Cursor skills symlink.
# Safe to run repeatedly (replaces stale symlinks). Supports macOS/Linux/WSL.
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

ensure_cursor_cli() {
  if command -v cursor >/dev/null 2>&1; then
    log "Cursor CLI found on PATH: $(command -v cursor)"
    log "Cursor CLI version: $(cursor --version 2>/dev/null || echo 'unknown')"
    return 0
  fi

  local app_cli="/Applications/Cursor.app/Contents/Resources/app/bin/cursor"
  if [ -x "$app_cli" ]; then
    log "Cursor app bundle detected but CLI is not on PATH."
    log "Fallback: export CURSOR_COMMAND=\"$app_cli\""
    log "Tip: add to shell profile so future shells can run 'cursor' directly."
    return 0
  fi

  if [ "$(uname -s)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    log "Cursor CLI missing; attempting install via Homebrew cask..."
    # If app is already installed, this can fail with a non-fatal "already exists" message.
    if brew install --cask cursor >/dev/null 2>&1; then
      log "Homebrew install completed."
    else
      log "Homebrew install did not complete cleanly (possibly already installed app). Continuing with detection."
    fi

    if command -v cursor >/dev/null 2>&1; then
      log "Cursor CLI now available on PATH: $(command -v cursor)"
      log "Cursor CLI version: $(cursor --version 2>/dev/null || echo 'unknown')"
      return 0
    fi

    if [ -x "$app_cli" ]; then
      log "Cursor app exists but PATH still missing CLI."
      log "Use CURSOR_COMMAND fallback: export CURSOR_COMMAND=\"$app_cli\""
      return 0
    fi
  fi

  fail "Cursor CLI not found. Install Cursor, then verify with 'cursor --version', or set CURSOR_COMMAND to an absolute CLI path."
}

link_cursor_skills() {
  local canonical="$REPO_ROOT/.claude/plugins/invoker/skills/plan-to-invoker"
  if [ ! -f "$canonical/SKILL.md" ]; then
    fail "expected skill at $canonical/SKILL.md"
  fi

  mkdir -p "$REPO_ROOT/.cursor/skills"
  cd "$REPO_ROOT/.cursor/skills"
  ln -sfn ../../.claude/plugins/invoker/skills/plan-to-invoker plan-to-invoker
  log "Cursor skill linked at .cursor/skills/plan-to-invoker -> .claude/plugins/invoker/skills/plan-to-invoker"
}

check_required_commands
ensure_cursor_cli
link_cursor_skills
log "Setup complete."
