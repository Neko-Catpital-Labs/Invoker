#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_FILE="${HOME}/.invoker/slack-complaint-scout-ledger.jsonl"
REPO="$ROOT"
AUTHOR="U0ALGQ64HMF"
WINDOW_HOURS=24
SKIP_LOCAL_CHECK=0
SKIP_LIVE=0
CHANNELS=()
TARGETS=()

usage() {
  printf '%s\n' "Usage: $0 [--skip-local-check] [--skip-live] [--repo PATH_OR_URL] [--state-file PATH] [--author USER_ID] [--window-hours HOURS] [--channel CHANNEL_ID]... [--target CHANNEL|THREAD_TS|FINGERPRINT]..."
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-local-check)
      SKIP_LOCAL_CHECK=1
      shift
      ;;
    --skip-live)
      SKIP_LIVE=1
      shift
      ;;
    --repo)
      REPO="${2:?--repo requires a value}"
      shift 2
      ;;
    --state-file)
      STATE_FILE="${2:?--state-file requires a value}"
      shift 2
      ;;
    --author)
      AUTHOR="${2:?--author requires a value}"
      shift 2
      ;;
    --window-hours)
      WINDOW_HOURS="${2:?--window-hours requires a value}"
      shift 2
      ;;
    --channel)
      CHANNELS+=("${2:?--channel requires a value}")
      shift 2
      ;;
    --target)
      TARGETS+=("${2:?--target requires a value}")
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$SKIP_LOCAL_CHECK" -eq 0 ]]; then
  python3 "$ROOT/scripts/slack-complaint-scout-discover.py" --self-test --repo "$REPO" --state-file "$STATE_FILE"
  pnpm --filter @invoker/surfaces test -- slack-plan-draft-approve.test.ts
  pnpm --filter @invoker/slack-manager test -- complaint-scout-bridge.test.ts
  pnpm --filter @invoker/surfaces build
  pnpm --filter @invoker/slack-manager build
fi

if [[ "$SKIP_LIVE" -eq 1 ]]; then
  printf '%s\n' "slack complaint scout driver: local checks complete; live pass skipped"
  exit 0
fi

BRIDGE="$ROOT/packages/slack-manager/dist/index.js"
if [[ ! -f "$BRIDGE" ]]; then
  printf '%s\n' "Slack draft bridge is not built at $BRIDGE. Run without --skip-local-check first." >&2
  exit 1
fi

ARGS=(
  "$ROOT/scripts/slack-complaint-scout-discover.py"
  --repo "$REPO"
  --state-file "$STATE_FILE"
  --author "$AUTHOR"
  --window-hours "$WINDOW_HOURS"
  --bridge "$BRIDGE"
  --act
  --json
)
for channel in "${CHANNELS[@]}"; do
  ARGS+=(--channel "$channel")
done
for target in "${TARGETS[@]}"; do
  ARGS+=(--target "$target")
done

python3 "${ARGS[@]}"
