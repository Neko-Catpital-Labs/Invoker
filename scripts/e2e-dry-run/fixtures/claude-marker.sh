#!/usr/bin/env bash
# Dummy Claude CLI for e2e-dry-run: no network, instant exit 0.
# Invoked like: claude --session-id <uuid> ... (prompt) or via INVOKER_CLAUDE_FIX_COMMAND (fix).
set -eu
SESSION_ID=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --session-id)
      if [ "$#" -lt 2 ]; then
        echo "claude-marker: --session-id requires a value" >&2
        exit 2
      fi
      SESSION_ID="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

ROOT="${INVOKER_E2E_MARKER_ROOT:-}"
if [ -n "$ROOT" ] && [ -n "$SESSION_ID" ]; then
  mkdir -p "$ROOT"
  # Portable timestamp (no %N on macOS bash)
  ts="$(date +%s)"
  echo ok >"$ROOT/${SESSION_ID}-${ts}-$$.marker"
fi

# Auto-resolve merge conflicts (no-op when none exist).
if git rev-parse --git-dir >/dev/null 2>&1; then
  UNMERGED=$(git diff --name-only --diff-filter=U 2>/dev/null || true)
  if [ -n "$UNMERGED" ]; then
    git checkout --theirs . 2>/dev/null || true
    git add -A 2>/dev/null || true
    git -c user.name='e2e-stub' -c user.email='stub@test' \
      commit --no-edit 2>/dev/null || true
  fi
fi

exit 0
