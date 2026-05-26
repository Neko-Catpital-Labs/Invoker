#!/usr/bin/env bash
set -euo pipefail

BATCH_DIR=""
EMIT=0

usage() {
  cat <<'EOF'
Usage: emit-mixpanel-events.sh --batch-dir PATH [--emit]

Writes mixpanel-export.jsonl in the batch folder. With --emit, imports events
to Mixpanel using MIXPANEL_TOKEN and either MIXPANEL_API_SECRET or service account auth.
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --batch-dir) BATCH_DIR="${2:-}"; shift 2 ;;
    --emit) EMIT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
done

[[ -n "$BATCH_DIR" ]] || die "Missing --batch-dir"
[[ -d "$BATCH_DIR" ]] || die "Missing batch dir: $BATCH_DIR"

BENCHMARK_ROOT="${BENCHMARK_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
ENV_FILE="${BENCHMARK_ENV_FILE:-$BENCHMARK_ROOT/config/benchmark.env}"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a
  source "$ENV_FILE"
  set +a
fi

python3 - "$BATCH_DIR" "${MIXPANEL_TOKEN:-}" "${MIXPANEL_SCHEMA_VERSION:-invoker_benchmark_v1}" <<'PY'
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

batch_dir = Path(sys.argv[1])
token = sys.argv[2]
schema = sys.argv[3]
summary_path = batch_dir / "summary.json"
summary = json.loads(summary_path.read_text()) if summary_path.exists() else {}
batch_id = summary.get("batch_id") or batch_dir.name
now = int(datetime.now(timezone.utc).timestamp())

def insert_id(*parts):
    key = "|".join(str(p) for p in parts)
    return "bench-" + hashlib.sha256(key.encode()).hexdigest()[:32]

def event(name, props):
    row_id = insert_id(batch_id, name, props.get("run_id", ""), props.get("task_id", ""))
    base = {
        "token": token,
        "distinct_id": "invoker-benchmark",
        "time": now,
        "$insert_id": row_id,
        "benchmark_schema_version": schema,
        "batch_id": batch_id,
    }
    base.update(props)
    return {"event": name, "properties": base}

events = [
    event("benchmark_batch", {
        "invoker_sha": summary.get("invoker_sha"),
        "job_count": summary.get("job_count", 0),
        "status_counts": summary.get("status_counts", {}),
    })
]

for job_path in sorted((batch_dir / "jobs").glob("*/job.json")):
    try:
        job = json.loads(job_path.read_text())
    except Exception:
        continue
    run_props = {
        "run_id": job.get("run_id"),
        "conversation_id": job.get("conversation_id"),
        "conversation_file": job.get("conversation_file"),
        "model": job.get("model"),
        "mode": job.get("mode"),
        "invoker_sha": job.get("invoker_sha"),
        "status": job.get("status"),
        "exit_code": job.get("exit_code"),
        "commit_count": len(job.get("commits") or []),
        "changed_file_count": len(job.get("changed_files") or []),
    }
    events.append(event("benchmark_run", run_props))
    events.append(event("benchmark_task", {
        **run_props,
        "task_id": job.get("run_id"),
        "workflow_id": job.get("workflow_id"),
        "terminal_state": job.get("status"),
        "manual": job.get("status") == "manual",
        "review_ready": job.get("status") == "review_ready",
        "timeout": job.get("status") == "timeout",
        "failed": job.get("status") in {"failed", "timeout", "invalid_job_json"},
    }))
    token_path = job_path.parent / "token-usage.json"
    if token_path.exists():
        try:
            usage = json.loads(token_path.read_text())
        except Exception:
            usage = {}
        events.append(event("benchmark_token_usage", {
            **run_props,
            "input_tokens": usage.get("input_tokens", 0),
            "cache_read_tokens": usage.get("cache_read_tokens", 0),
            "cache_creation_tokens": usage.get("cache_creation_tokens", 0),
            "output_tokens": usage.get("output_tokens", 0),
            "reasoning_tokens": usage.get("reasoning_tokens", 0),
            "total_tokens": usage.get("total_tokens", 0),
            "fresh_input_tokens": usage.get("fresh_input_tokens", 0),
            "normalized_total_tokens": usage.get("normalized_total_tokens", 0),
            "estimated_cost_usd": usage.get("estimated_cost_usd", 0),
            "phase": usage.get("phase", "task"),
            "autofix_phase_cost_usd": usage.get("autofix_phase_cost_usd", 0),
            "original_phase_cost_usd": usage.get("original_phase_cost_usd", usage.get("estimated_cost_usd", 0)),
        }))

out = batch_dir / "mixpanel-export.jsonl"
out.write_text("\n".join(json.dumps(item, sort_keys=True) for item in events) + "\n")
print(f"wrote {len(events)} events to {out}")
PY

if [[ "$EMIT" -ne 1 ]]; then
  exit 0
fi

[[ -n "${MIXPANEL_TOKEN:-}" ]] || die "Missing MIXPANEL_TOKEN"
if [[ -z "${MIXPANEL_API_SECRET:-}" && ( -z "${MIXPANEL_SERVICE_ACCOUNT_USER:-}" || -z "${MIXPANEL_SERVICE_ACCOUNT_PASS:-}" ) ]]; then
  die "Missing Mixpanel auth: set MIXPANEL_API_SECRET or MIXPANEL_SERVICE_ACCOUNT_USER + MIXPANEL_SERVICE_ACCOUNT_PASS"
fi

python3 - "$BATCH_DIR/mixpanel-export.jsonl" "${MIXPANEL_ENDPOINT:-https://api.mixpanel.com/import}" "${MIXPANEL_PROJECT_ID:-}" <<'PY'
import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

jsonl, endpoint, project_id = sys.argv[1:]
events = [json.loads(line) for line in Path(jsonl).read_text().splitlines() if line.strip()]
if project_id:
    sep = "&" if "?" in endpoint else "?"
    endpoint = f"{endpoint}{sep}{urllib.parse.urlencode({'project_id': project_id})}"

user = os.getenv("MIXPANEL_SERVICE_ACCOUNT_USER") or ""
password = os.getenv("MIXPANEL_SERVICE_ACCOUNT_PASS") or ""
api_secret = os.getenv("MIXPANEL_API_SECRET") or ""
if user and password:
    auth = base64.b64encode(f"{user}:{password}".encode()).decode()
elif api_secret:
    auth = base64.b64encode(f"{api_secret}:".encode()).decode()
else:
    raise SystemExit("missing auth")

for offset in range(0, len(events), 2000):
    payload = json.dumps(events[offset:offset + 2000]).encode()
    req = urllib.request.Request(endpoint, data=payload, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", f"Basic {auth}")
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            body = response.read().decode()
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"Mixpanel import failed: HTTP {exc.code} {exc.read().decode(errors='ignore')}")
    if body and body not in {"1", "OK"}:
        print(body)
print(f"emitted {len(events)} Mixpanel events")
PY
