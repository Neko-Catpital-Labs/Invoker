#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO_ROOT/config/nightly-usage.env"
RUN_DATE=""
DRY_RUN=0
SKIP_CACHE_AUDIT=0
SKIP_REPORT=0
IGNORE_LOCAL_STATE="${USAGE_PIPELINE_IGNORE_LOCAL_STATE:-0}"

usage() {
  cat <<'EOF'
Usage: bash scripts/nightly_usage_pipeline.sh [--dry-run] [--date YYYY-MM-DD] [--env-file PATH] [--skip-cache-audit] [--skip-report] [--ignore-local-state]

Options:
  --dry-run            Build payloads but do not publish to Mixpanel.
  --date YYYY-MM-DD    Report date to stamp on exported events (default: yesterday, local time).
  --env-file PATH      Environment file (default: config/nightly-usage.env).
  --skip-cache-audit   Reuse existing cache-hit-audit-report.json.
  --skip-report        Reuse existing reports/planning-vs-execution-* artifacts.
  --ignore-local-state Force exporter resubmit; rely on Mixpanel $insert_id dedupe.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --date)
      RUN_DATE="${2:-}"
      [[ -n "$RUN_DATE" ]] || { echo "Missing value for --date" >&2; exit 2; }
      shift 2
      ;;
    --env-file)
      ENV_FILE="${2:-}"
      [[ -n "$ENV_FILE" ]] || { echo "Missing value for --env-file" >&2; exit 2; }
      shift 2
      ;;
    --skip-cache-audit)
      SKIP_CACHE_AUDIT=1
      shift
      ;;
    --skip-report)
      SKIP_REPORT=1
      shift
      ;;
    --ignore-local-state)
      IGNORE_LOCAL_STATE=1
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

if [[ -z "$RUN_DATE" ]]; then
  RUN_DATE="$(python3 - <<'PY'
from datetime import date, timedelta
print((date.today() - timedelta(days=1)).isoformat())
PY
)"
fi

[[ -f "$ENV_FILE" ]] || {
  echo "Missing env file: $ENV_FILE" >&2
  echo "Create it from config/nightly-usage.env.example" >&2
  exit 1
}

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

[[ -n "${MIXPANEL_TOKEN:-}" ]] || {
  echo "Missing required env: MIXPANEL_TOKEN" >&2
  exit 1
}
if [[ "$DRY_RUN" -ne 1 ]]; then
  if [[ -z "${MIXPANEL_API_SECRET:-}" ]] && [[ -z "${MIXPANEL_SERVICE_ACCOUNT_USER:-}" || -z "${MIXPANEL_SERVICE_ACCOUNT_PASS:-}" ]]; then
    echo "Missing Mixpanel auth: set MIXPANEL_API_SECRET or MIXPANEL_SERVICE_ACCOUNT_USER + MIXPANEL_SERVICE_ACCOUNT_PASS" >&2
    exit 1
  fi
fi

LOG_DIR="${USAGE_PIPELINE_LOG_DIR:-$HOME/.invoker/usage-metrics}"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/nightly-run.log"

run_step() {
  local name="$1"
  shift
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] STEP_START $name" | tee -a "$LOG_FILE"
  "$@" 2>&1 | tee -a "$LOG_FILE"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] STEP_OK $name" | tee -a "$LOG_FILE"
}

cd "$REPO_ROOT"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] RUN_START date=$RUN_DATE dry_run=$DRY_RUN repo=$REPO_ROOT" | tee -a "$LOG_FILE"

if [[ "$SKIP_CACHE_AUDIT" -eq 0 ]]; then
  run_step "cache_hit_audit" python3 scripts/cache_hit_audit.py --output cache-hit-audit-report.json --top 50
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] STEP_SKIP cache_hit_audit" | tee -a "$LOG_FILE"
fi

if [[ "$SKIP_REPORT" -eq 0 ]]; then
  run_step "planning_vs_execution_report" python3 scripts/planning_vs_execution_report.py --out-dir reports
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] STEP_SKIP planning_vs_execution_report" | tee -a "$LOG_FILE"
fi

[[ -f "$REPO_ROOT/cache-hit-audit-report.json" ]] || {
  echo "Missing required artifact: cache-hit-audit-report.json" | tee -a "$LOG_FILE" >&2
  exit 1
}
[[ -f "$REPO_ROOT/reports/planning-vs-execution-report.json" ]] || {
  echo "Missing required artifact: reports/planning-vs-execution-report.json" | tee -a "$LOG_FILE" >&2
  exit 1
}

EXPORT_ARGS=(python3 scripts/mixpanel_export_usage.py --input-root "$REPO_ROOT" --date "$RUN_DATE")
if [[ "$DRY_RUN" -eq 1 ]]; then
  EXPORT_ARGS+=(--dry-run)
fi
if [[ "$IGNORE_LOCAL_STATE" == "1" ]]; then
  EXPORT_ARGS+=(--ignore-local-state)
fi

run_step "mixpanel_export" "${EXPORT_ARGS[@]}"

STATUS_LINE="USAGE_PIPELINE_STATUS date=$RUN_DATE dry_run=$DRY_RUN skip_cache_audit=$SKIP_CACHE_AUDIT skip_report=$SKIP_REPORT ignore_local_state=$IGNORE_LOCAL_STATE status=ok"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] $STATUS_LINE" | tee -a "$LOG_FILE"
