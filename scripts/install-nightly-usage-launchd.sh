#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$REPO_ROOT/scripts/launchd/com.invoker.usage-metrics.plist.template"
LABEL="com.invoker.usage-metrics"
ENV_FILE="$REPO_ROOT/config/nightly-usage.env"
TIME_SPEC="02:10"
PIPELINE_DRY_RUN=0
DRY_RUN=0
LOG_DIR="${USAGE_PIPELINE_LOG_DIR:-$HOME/.invoker/usage-metrics}"
PLIST_DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"

usage() {
  cat <<'EOF'
Usage: bash scripts/install-nightly-usage-launchd.sh [options]

Options:
  --time HH:MM          Local launchd schedule time (default: 02:10)
  --env-file PATH       Env file path passed to nightly runner
  --pipeline-dry-run    Add --dry-run when launchd executes the pipeline
  --dry-run             Print generated plist and commands without installing
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --time)
      TIME_SPEC="${2:-}"
      [[ -n "$TIME_SPEC" ]] || { echo "Missing value for --time" >&2; exit 2; }
      shift 2
      ;;
    --env-file)
      ENV_FILE="${2:-}"
      [[ -n "$ENV_FILE" ]] || { echo "Missing value for --env-file" >&2; exit 2; }
      shift 2
      ;;
    --pipeline-dry-run)
      PIPELINE_DRY_RUN=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! "$TIME_SPEC" =~ ^([01]?[0-9]|2[0-3]):([0-5][0-9])$ ]]; then
  echo "Invalid --time value: $TIME_SPEC (expected HH:MM)" >&2
  exit 2
fi
HOUR="${TIME_SPEC%%:*}"
MINUTE="${TIME_SPEC##*:}"
HOUR=$((10#$HOUR))
MINUTE=$((10#$MINUTE))

[[ -f "$TEMPLATE" ]] || { echo "Missing template: $TEMPLATE" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "Missing env file: $ENV_FILE" >&2; exit 1; }
ENV_FILE="$(python3 - <<'PY' "$ENV_FILE"
from pathlib import Path
import sys
print(str(Path(sys.argv[1]).expanduser().resolve()))
PY
)"
mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

if [[ "$PIPELINE_DRY_RUN" -eq 1 ]]; then
  DRY_RUN_ARG="<string>--dry-run</string>"
else
  DRY_RUN_ARG=""
fi

rendered="$(python3 - <<'PY' "$TEMPLATE" "$REPO_ROOT" "$ENV_FILE" "$HOUR" "$MINUTE" "$LOG_DIR" "$DRY_RUN_ARG"
from pathlib import Path
import sys

template = Path(sys.argv[1]).read_text()
replacements = {
    "__REPO_ROOT__": sys.argv[2],
    "__ENV_FILE__": sys.argv[3],
    "__HOUR__": sys.argv[4],
    "__MINUTE__": sys.argv[5],
    "__LOG_DIR__": sys.argv[6],
    "__PIPELINE_DRY_RUN_ARG__": sys.argv[7],
}
for key, value in replacements.items():
    template = template.replace(key, value)
print(template)
PY
)"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "DRY RUN: would write $PLIST_DEST"
  echo "$rendered"
  echo "DRY RUN: would run -> launchctl bootstrap gui/$(id -u) \"$PLIST_DEST\""
  echo "DRY RUN: would run -> launchctl kickstart -k gui/$(id -u)/$LABEL"
  exit 0
fi

printf '%s\n' "$rendered" > "$PLIST_DEST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
launchctl print "gui/$(id -u)/$LABEL" >/dev/null
echo "Installed launchd job: $LABEL"
echo "Plist: $PLIST_DEST"
echo "Schedule: $TIME_SPEC local time"
