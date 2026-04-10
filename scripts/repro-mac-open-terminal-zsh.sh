#!/usr/bin/env bash
# Repro / verify: headless open-terminal on macOS uses zsh for branch-checkout worktrees.
#
# Matches the GUI "Open Terminal" path (openExternalTerminalForTask → osascript).
#
# Prerequisites:
#   - macOS (Darwin)
#   - pnpm --filter @invoker/app build  (dist/main.js)
#   - A non-running task id with worktree + branch metadata (merge-clone / reconciliation style).
#     Cwd-only specs skip the zsh wrapper (Terminal opens via `open -a`); this script will say so.
#
# Usage:
#   bash scripts/repro-mac-open-terminal-zsh.sh '<taskId>'
#   bash scripts/repro-mac-open-terminal-zsh.sh --expect bash '<taskId>'   # assert old bash behavior
#
# Environment (optional): same as your normal Invoker run (e.g. INVOKER_DB_DIR if you use a non-default DB).
#
# Exit codes:
#   0 — assertion passed (or cwd-only / agent resume: not applicable, reported)
#   1 — assertion failed or open-terminal error
#   2 — bad arguments / missing build / not macOS

set -euo pipefail

EXPECT=zsh
TASK_ID=

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect)
      EXPECT=${2:-}
      shift 2
      ;;
    -h|--help)
      sed -n '2,25p' "$0"
      exit 2
      ;;
    *)
      TASK_ID=$1
      shift
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This repro is for macOS only (current: $(uname -s))." >&2
  exit 2
fi

if [[ -z "$TASK_ID" ]]; then
  echo "Usage: $0 [--expect zsh|bash] <taskId>" >&2
  exit 2
fi

if [[ "$EXPECT" != "zsh" && "$EXPECT" != "bash" ]]; then
  echo "Invalid --expect (use zsh or bash): $EXPECT" >&2
  exit 2
fi

INVOKER_MONO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$INVOKER_MONO"

MAIN_JS="$INVOKER_MONO/packages/app/dist/main.js"
if [[ ! -f "$MAIN_JS" ]]; then
  echo "Missing $MAIN_JS — run: pnpm --filter @invoker/app build" >&2
  exit 2
fi

ELECTRON_BIN="$INVOKER_MONO/packages/app/node_modules/.bin/electron"
if [[ ! -x "$ELECTRON_BIN" ]]; then
  echo "Missing electron at $ELECTRON_BIN — run pnpm install from repo root" >&2
  exit 2
fi

TMP_LOG="$(mktemp -t invoker-open-terminal-zsh.XXXXXX)"
cleanup() { rm -f "$TMP_LOG"; }
trap cleanup EXIT

echo "==> Task: $TASK_ID"
echo "==> Expecting interactive shell wrapper in logged spec: $EXPECT"
echo "==> Running headless open-terminal (logs → $TMP_LOG)"
set +e
"$ELECTRON_BIN" "$MAIN_JS" --headless open-terminal "$TASK_ID" 2>&1 | tee "$TMP_LOG"
OPEN_EC=${PIPESTATUS[0]:-0}
set -e

SPEC_LINE=$(grep '\[open-terminal\] getRestoredTerminalSpec returned:' "$TMP_LOG" | tail -1 || true)
if [[ -z "$SPEC_LINE" ]]; then
  echo "FAIL: missing log line [open-terminal] getRestoredTerminalSpec returned:" >&2
  echo "       (task missing, wrong DB, or headless failed before spec build)" >&2
  exit 1
fi

echo ""
echo "==> Spec log line:"
echo "    $SPEC_LINE"

if [[ "$SPEC_LINE" == *'command=undefined'* ]]; then
  echo ""
  echo "SKIP: cwd-only terminal spec (no bash/zsh -c wrapper). Use a task with branch + worktree metadata."
  if [[ "$OPEN_EC" -ne 0 ]]; then
    echo "WARN: open-terminal exited with code $OPEN_EC" >&2
  fi
  exit 0
fi

if [[ "$SPEC_LINE" == *'command=claude'* || "$SPEC_LINE" == *'command=codex'* || "$SPEC_LINE" == *'command=docker'* || "$SPEC_LINE" == *'command=ssh'* ]]; then
  echo ""
  echo "SKIP: agent/remote/docker spec — zsh vs bash wrapper check applies to worktree branch checkout shells only."
  if [[ "$OPEN_EC" -ne 0 ]]; then
    echo "WARN: open-terminal exited with code $OPEN_EC" >&2
  fi
  exit 0
fi

if [[ "$EXPECT" == "zsh" ]]; then
  if [[ "$SPEC_LINE" != *'command=zsh'* ]]; then
    echo "FAIL: expected command=zsh in spec log on macOS (got something else — still bash?)." >&2
    exit 1
  fi
  if ! grep -q 'exec zsh' <<<"$SPEC_LINE"; then
    echo "FAIL: spec log should contain exec zsh for branch-checkout zsh wrapper." >&2
    exit 1
  fi
else
  if [[ "$SPEC_LINE" != *'command=bash'* ]]; then
    echo "FAIL: expected command=bash in spec log for --expect bash." >&2
    exit 1
  fi
  if ! grep -q 'exec bash' <<<"$SPEC_LINE"; then
    echo "FAIL: spec log should contain exec bash when asserting pre-fix bash behavior." >&2
    exit 1
  fi
fi

if [[ "$OPEN_EC" -ne 0 ]]; then
  echo "WARN: open-terminal exited with code $OPEN_EC (spec assertion still passed)." >&2
fi

echo ""
echo "PASS: logged spec matches --expect $EXPECT for worktree branch-checkout shell wrapper."
