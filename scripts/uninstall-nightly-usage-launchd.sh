#!/usr/bin/env bash
set -euo pipefail

LABEL="com.invoker.usage-metrics"
PLIST_DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: bash scripts/uninstall-nightly-usage-launchd.sh [--dry-run]
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
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

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "DRY RUN: would run -> launchctl bootout gui/$(id -u)/$LABEL"
  echo "DRY RUN: would remove -> $PLIST_DEST"
  exit 0
fi

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST_DEST"
echo "Removed launchd job: $LABEL"
