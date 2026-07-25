#!/usr/bin/env bash
# Repro: installed Invoker.app still embeds Slack Socket Mode, and
# scripts/kill-all-electron.sh historically did NOT match that process — so a
# desktop Invoker (or invoker-ui --headless owner-serve) can steal Socket Mode
# events from local `pnpm --filter @invoker/slack-manager start`.
#
# Observed incident: @Invoker /plan got answers from another consumer while local
# slack-manager logs showed zero MENTION_RECEIVED for those event_ts values.
# Killing Invoker.app (beyond what kill-all-electron matched) made the next
# /plan hit local immediately.
#
# Usage:
#   bash scripts/repro/repro-embedded-slack-dual-consumer.sh --expect bug
#   bash scripts/repro/repro-embedded-slack-dual-consumer.sh --expect fixed
#
# Exit 0 = observed matcher coverage matches --expect
# Exit 1 = observed matcher coverage does not match --expect
# Exit 2 = invalid args / missing kill script
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
KILL_SCRIPT="$REPO_ROOT/scripts/kill-all-electron.sh"
EXPECTATION=""

log() { printf '[repro-embedded-slack] %s\n' "$*"; }

usage() {
  sed -n '2,18p' "$0" | sed 's/^# \?//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect)
      EXPECTATION="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      log "unknown arg: $1"
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$EXPECTATION" != "bug" && "$EXPECTATION" != "fixed" ]]; then
  log "--expect requires bug|fixed"
  usage >&2
  exit 2
fi

[[ -f "$KILL_SCRIPT" ]] || { log "missing $KILL_SCRIPT"; exit 2; }

# Mirror the LIVE case-arm in kill-all-electron.sh (keep in sync when reading
# failures; the source-of-truth check below greps the file directly).
live_kill_all_electron_matches() {
  local command=$1
  case "$command" in
    *kill-all-electron.sh*) return 1 ;;
    *Electron.app/Contents/MacOS/Electron*|*"node "*scripts/electron.cjs*|*Invoker.app/Contents/MacOS/Invoker*|*packages/app/dist/main.js*)
      # Expanded arm used only after the fix lands; live script may still lack it.
      if grep -qF 'Invoker.app/Contents/MacOS/Invoker' "$KILL_SCRIPT" \
        && grep -qF 'packages/app/dist/main.js' "$KILL_SCRIPT"; then
        return 0
      fi
      case "$command" in
        *Electron.app/Contents/MacOS/Electron*|*"node "*scripts/electron.cjs*) return 0 ;;
        *) return 1 ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

log "=== Part 1: kill-all-electron.sh coverage for Invoker.app Socket Mode owners ==="

REQUIRED_SUBSTRINGS=(
  'Invoker.app/Contents/MacOS/Invoker'
  'packages/app/dist/main.js'
)
MATCHERS_PRESENT=1
for needle in "${REQUIRED_SUBSTRINGS[@]}"; do
  if grep -qF "$needle" "$KILL_SCRIPT"; then
    log "script contains matcher for: $needle"
  else
    log "kill-all-electron.sh missing matcher for: $needle"
    MATCHERS_PRESENT=0
  fi
done

FIXTURES=(
  '/Applications/Invoker.app/Contents/MacOS/Invoker'
  '/opt/homebrew/lib/node_modules/@neko-catpital-labs/invoker-ui/vendor/Invoker.app/Contents/MacOS/Invoker --headless owner-serve'
  '/Users/me/Invoker/node_modules/.pnpm/electron@35.7.5/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron packages/app/dist/main.js'
)

FIXTURE_COVERAGE_OK=1
for cmd in "${FIXTURES[@]}"; do
  if live_kill_all_electron_matches "$cmd"; then
    log "matcher hits: $cmd"
  else
    log "matcher MISSES competing owner: $cmd"
    FIXTURE_COVERAGE_OK=0
  fi
done

BUG_PRESENT=0
if [[ "$MATCHERS_PRESENT" -eq 0 || "$FIXTURE_COVERAGE_OK" -eq 0 ]]; then
  BUG_PRESENT=1
fi

log "=== Part 2: root-cause evidence — packaged Invoker.app embeds Slack ==="

ASARS=(
  /Applications/Invoker.app/Contents/Resources/app.asar
  /opt/homebrew/lib/node_modules/@neko-catpital-labs/invoker-ui/vendor/Invoker.app/Contents/Resources/app.asar
)
FOUND_ASAR=
asar_has() {
  python3 - "$1" "$2" <<'PY'
import sys
from pathlib import Path
data = Path(sys.argv[1]).read_bytes()
sys.exit(0 if sys.argv[2].encode() in data else 1)
PY
}
for asar in "${ASARS[@]}"; do
  [[ -f "$asar" ]] || continue
  FOUND_ASAR=$asar
  log "inspecting $asar"
  if asar_has "$asar" 'Slack bot started (embedded in GUI)'; then
    log "PROOF: asar starts Slack in-process (embedded in GUI)"
  else
    log "WARN: asar present but missing embedded-Slack marker: $asar"
  fi
  if asar_has "$asar" 'wireSlackBot'; then
    log "PROOF: asar contains wireSlackBot"
  else
    log "WARN: asar present but missing wireSlackBot: $asar"
  fi
  if asar_has "$asar" 'acquireSlackConsumerLock'; then
    log "asar includes consumer lock symbol"
  else
    log "PROOF: asar has NO acquireSlackConsumerLock — ignores slack-manager's lock file"
  fi
done

if [[ -z "$FOUND_ASAR" ]]; then
  log "WARN: no Invoker.app asar on this machine; install evidence skipped (Part 1 still gates coverage)"
fi

log "=== Part 3: slack-manager lock cannot serialize Invoker.app (informational) ==="
LOCK_SRC="$REPO_ROOT/packages/slack-manager/src/slack-consumer-lock.ts"
if [[ -f "$LOCK_SRC" ]] && ! grep -qF 'Invoker.app' "$LOCK_SRC"; then
  log "PROOF: slack-consumer-lock.ts never mentions Invoker.app (PID lock is slack-manager-only)"
fi

if [[ "$BUG_PRESENT" -eq 1 ]]; then
  cat <<EOF

[repro-embedded-slack] BUG PRESENT:
  1. Packaged Invoker.app still calls wireSlackBot / startSlackBot (Socket Mode in GUI).
  2. scripts/kill-all-electron.sh does not cover Invoker.app / app dist competitors.
  3. slack-manager's ~/.invoker/locks/slack-socket-consumer.lock is never acquired by Invoker.app,
     so both clients connect; Slack load-balances events between them.
EOF
else
  log "BUG ABSENT: kill-all-electron covers Invoker.app / app-dist Slack competitors."
fi

if [[ "$EXPECTATION" == "bug" ]]; then
  if [[ "$BUG_PRESENT" -eq 1 ]]; then
    log "PASS: --expect bug matched (coverage gap still open)."
    exit 0
  fi
  log "FAIL: --expect bug but kill-all-electron already covers Invoker.app competitors."
  exit 1
fi

if [[ "$BUG_PRESENT" -eq 0 ]]; then
  log "PASS: --expect fixed matched."
  exit 0
fi
log "FAIL: --expect fixed but kill-all-electron still misses Invoker.app competitors."
exit 1
