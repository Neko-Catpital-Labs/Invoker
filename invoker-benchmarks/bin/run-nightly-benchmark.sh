#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$DEFAULT_ROOT/config/benchmark.env"
WORKERS_FILE=""
DRY_RUN=0
SMOKE=0
LIMIT=""
EMIT_MIXPANEL=0
EMIT_MIXPANEL_SET=0

usage() {
  cat <<'EOF'
Usage: run-nightly-benchmark.sh [--dry-run] [--smoke] [--limit N] [--emit-mixpanel] [--no-emit-mixpanel] [--env-file PATH] [--workers-file PATH]

Options:
  --dry-run          Validate config and print the job assignment plan only.
  --smoke            Run one conversation across all modes for the first model on one worker.
  --limit N          Run only the first N matrix jobs.
  --emit-mixpanel    Publish Mixpanel events after aggregation.
  --no-emit-mixpanel Write mixpanel-export.jsonl but do not publish.
  --env-file PATH    Benchmark env file. Defaults to config/benchmark.env.
  --workers-file PATH Worker inventory JSON. Defaults to config/workers.json.
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] $*"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --smoke) SMOKE=1; shift ;;
    --limit)
      LIMIT="${2:-}"
      [[ "$LIMIT" =~ ^[0-9]+$ ]] || die "Missing or invalid value for --limit"
      shift 2
      ;;
    --emit-mixpanel) EMIT_MIXPANEL=1; EMIT_MIXPANEL_SET=1; shift ;;
    --no-emit-mixpanel) EMIT_MIXPANEL=0; EMIT_MIXPANEL_SET=1; shift ;;
    --env-file)
      ENV_FILE="${2:-}"
      [[ -n "$ENV_FILE" ]] || die "Missing value for --env-file"
      shift 2
      ;;
    --workers-file)
      WORKERS_FILE="${2:-}"
      [[ -n "$WORKERS_FILE" ]] || die "Missing value for --workers-file"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
done

[[ -f "$ENV_FILE" ]] || die "Missing env file: $ENV_FILE"

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

export TZ="${TZ:-Asia/Hong_Kong}"
BENCHMARK_ROOT="${BENCHMARK_ROOT:-$DEFAULT_ROOT}"
WORKERS_FILE="${WORKERS_FILE:-$BENCHMARK_ROOT/config/workers.json}"
MANIFEST_FILE="${MANIFEST_FILE:-$BENCHMARK_ROOT/config/corpus-manifest.json}"
RUNS_DIR="$BENCHMARK_ROOT/runs"
MODELS="${MODELS:-codex,claude}"
MODES="${MODES:-baseline_direct,invoker_workflow,invoker_auto_fix}"
WORKER_CONCURRENCY_PER_HOST="${WORKER_CONCURRENCY_PER_HOST:-1}"
if [[ "$EMIT_MIXPANEL_SET" -eq 0 && "$DRY_RUN" -eq 0 && "$SMOKE" -eq 0 && "${BENCHMARK_EMIT_MIXPANEL_DEFAULT:-1}" != "0" ]]; then
  EMIT_MIXPANEL=1
fi

[[ "$WORKER_CONCURRENCY_PER_HOST" == "1" ]] || die "Only WORKER_CONCURRENCY_PER_HOST=1 is currently supported"
[[ -n "${CORPUS_DIR:-}" ]] || die "Missing CORPUS_DIR"
[[ -n "${INVOKER_REPO:-}" ]] || die "Missing INVOKER_REPO"
[[ -n "${INVOKER_BRANCH:-}" ]] || die "Missing INVOKER_BRANCH"

if [[ ! -f "$WORKERS_FILE" ]]; then
  if [[ -f "$HOME/.invoker/config.json" ]]; then
    log "workers.json missing; generating from ~/.invoker/config.json"
    "$BENCHMARK_ROOT/bin/sync-worker-credentials.sh" --write-workers "$WORKERS_FILE" --no-ssh
  else
    die "Missing workers file: $WORKERS_FILE"
  fi
fi

mapfile -t WORKERS < <(python3 - "$WORKERS_FILE" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
for worker in data.get("workers", []):
    if worker.get("enabled", True):
        user = worker.get("user") or "invoker"
        host = worker.get("host") or worker.get("name")
        port = int(worker.get("port") or 22)
        name = worker.get("name") or host
        if host:
            print(f"{name}\t{user}@{host}\t{port}")
PY
)

[[ "${#WORKERS[@]}" -gt 0 ]] || die "No enabled workers in $WORKERS_FILE"
if [[ "$SMOKE" -eq 1 ]]; then
  WORKERS=("${WORKERS[0]}")
fi

INVOKER_SHA="${INVOKER_SHA:-}"
if [[ -z "$INVOKER_SHA" ]]; then
  if INVOKER_SHA="$(git ls-remote "$INVOKER_REPO" "refs/heads/$INVOKER_BRANCH" | awk '{print $1}' | head -n 1)" && [[ -n "$INVOKER_SHA" ]]; then
    :
  elif [[ "$DRY_RUN" -eq 1 ]]; then
    INVOKER_SHA="dry-run-unresolved"
  else
    die "Unable to resolve $INVOKER_REPO $INVOKER_BRANCH"
  fi
fi

RUN_STAMP="$(date '+%Y-%m-%d_%H-%M-%S_%Z')"
BATCH_ID="${BATCH_ID:-${RUN_STAMP}_$(printf '%s' "$INVOKER_SHA" | cut -c1-12)_$$}"
BATCH_DIR="$RUNS_DIR/$BATCH_ID"
MATRIX_FILE="$BATCH_DIR/job-matrix.tsv"
ASSIGNMENTS_FILE="$BATCH_DIR/worker-assignments.tsv"

mkdir -p "$BATCH_DIR/jobs"

python3 - "$CORPUS_DIR" "$MANIFEST_FILE" "$MODELS" "$MODES" "$SMOKE" "${LIMIT:-}" "$MATRIX_FILE" "$ASSIGNMENTS_FILE" "${WORKERS[@]}" <<'PY'
import glob
import json
import sys
from pathlib import Path

corpus_dir = Path(sys.argv[1])
manifest_file = Path(sys.argv[2])
models = [x.strip() for x in sys.argv[3].split(",") if x.strip()]
modes = [x.strip() for x in sys.argv[4].split(",") if x.strip()]
smoke = sys.argv[5] == "1"
limit = int(sys.argv[6]) if sys.argv[6] else None
matrix_file = Path(sys.argv[7])
assignments_file = Path(sys.argv[8])
workers = [item.split("\t", 2) for item in sys.argv[9:]]

manifest = {}
if manifest_file.exists():
    manifest = json.loads(manifest_file.read_text())

conversations = []
if "sessions" in manifest:
    for item in manifest["sessions"]:
        rel = item["file"] if isinstance(item, dict) else str(item)
        conversations.append(corpus_dir / rel)
else:
    globs = manifest.get("file_globs") or ["*.jsonl", "*.json", "*.md", "*.txt"]
    seen = set()
    for pattern in globs:
        for path in sorted(glob.glob(str(corpus_dir / pattern))):
            if path not in seen:
                seen.add(path)
                conversations.append(Path(path))

expected = manifest.get("expected_conversation_count")
if not conversations:
    raise SystemExit(f"No corpus conversations found in {corpus_dir}")
if expected and len(conversations) != int(expected):
    raise SystemExit(f"Expected {expected} corpus conversations, found {len(conversations)} in {corpus_dir}")

if smoke:
    conversations = conversations[:1]
    models = models[:1]

jobs = []
for conversation in conversations:
    session_id = conversation.stem
    for model in models:
        for mode in modes:
            run_id = f"{session_id}__{model}__{mode}"
            jobs.append((run_id, str(conversation), session_id, model, mode))

if limit is not None:
    jobs = jobs[:limit]

matrix_file.write_text("\n".join("\t".join(row) for row in jobs) + ("\n" if jobs else ""))

lines = []
for index, row in enumerate(jobs):
    worker = workers[index % len(workers)]
    lines.append("\t".join([worker[0], worker[1], worker[2], *row]))
assignments_file.write_text("\n".join(lines) + ("\n" if lines else ""))

print(f"conversation_count={len(conversations)}")
print(f"model_count={len(models)}")
print(f"mode_count={len(modes)}")
print(f"job_count={len(jobs)}")
print(f"worker_count={len(workers)}")
PY

log "batch_id=$BATCH_ID invoker_sha=$INVOKER_SHA"
log "matrix=$(wc -l < "$MATRIX_FILE" | tr -d ' ') jobs assignments=$ASSIGNMENTS_FILE"

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "dry-run worker assignment plan:"
  column -t -s $'\t' "$ASSIGNMENTS_FILE" || cat "$ASSIGNMENTS_FILE"
  exit 0
fi

sync_runtime_to_worker() {
  local target="$1"
  local port="$2"
  ssh -p "$port" "$target" "mkdir -p '$BENCHMARK_ROOT/bin' '$BENCHMARK_ROOT/config' '$BENCHMARK_ROOT/corpus' '$BENCHMARK_ROOT/runs'"
  rsync -az -e "ssh -p $port" "$BENCHMARK_ROOT/bin/" "$target:$BENCHMARK_ROOT/bin/"
  rsync -az -e "ssh -p $port" "$BENCHMARK_ROOT/config/" "$target:$BENCHMARK_ROOT/config/"
  rsync -az -e "ssh -p $port" "$CORPUS_DIR/" "$target:$CORPUS_DIR/"
}

run_worker_queue() {
  local worker_name="$1"
  local target="$2"
  local port="$3"
  local queue_file="$4"
  local worker_log="$BATCH_DIR/${worker_name}.log"

  log "syncing runtime to $worker_name"
  sync_runtime_to_worker "$target" "$port" >>"$worker_log" 2>&1

  while IFS=$'\t' read -r run_id conversation_file session_id model mode; do
    [[ -n "$run_id" ]] || continue
    log "dispatch worker=$worker_name run_id=$run_id"
    if ssh -p "$port" "$target" \
      "BENCHMARK_ROOT='$BENCHMARK_ROOT' '$BENCHMARK_ROOT/bin/run-worker-job.sh' --batch-id '$BATCH_ID' --run-id '$run_id' --conversation-file '$conversation_file' --model '$model' --mode '$mode' --invoker-sha '$INVOKER_SHA'" \
      >>"$worker_log" 2>&1; then
      log "complete worker=$worker_name run_id=$run_id"
    else
      log "failed worker=$worker_name run_id=$run_id"
    fi
    mkdir -p "$BATCH_DIR/jobs/$run_id"
    rsync -az -e "ssh -p $port" "$target:$BENCHMARK_ROOT/runs/$BATCH_ID/jobs/$run_id/" "$BATCH_DIR/jobs/$run_id/" >>"$worker_log" 2>&1 || true
  done < "$queue_file"
}

QUEUE_DIR="$BATCH_DIR/queues"
mkdir -p "$QUEUE_DIR"
while IFS=$'\t' read -r worker_name target port run_id conversation_file session_id model mode; do
  printf '%s\t%s\t%s\t%s\t%s\n' "$run_id" "$conversation_file" "$session_id" "$model" "$mode" >>"$QUEUE_DIR/$worker_name.tsv"
done < "$ASSIGNMENTS_FILE"

pids=()
for worker in "${WORKERS[@]}"; do
  IFS=$'\t' read -r worker_name target port <<<"$worker"
  queue_file="$QUEUE_DIR/$worker_name.tsv"
  [[ -s "$queue_file" ]] || continue
  run_worker_queue "$worker_name" "$target" "$port" "$queue_file" &
  pids+=("$!")
done

status=0
for pid in "${pids[@]}"; do
  if ! wait "$pid"; then
    status=1
  fi
done

python3 - "$BATCH_DIR" "$BATCH_ID" "$INVOKER_SHA" <<'PY'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

batch_dir = Path(sys.argv[1])
batch_id = sys.argv[2]
invoker_sha = sys.argv[3]
jobs = []
for path in sorted((batch_dir / "jobs").glob("*/job.json")):
    try:
        jobs.append(json.loads(path.read_text()))
    except json.JSONDecodeError:
        jobs.append({"run_id": path.parent.name, "status": "invalid_job_json"})

counts = {}
for job in jobs:
    counts[job.get("status", "unknown")] = counts.get(job.get("status", "unknown"), 0) + 1

summary = {
    "batch_id": batch_id,
    "invoker_sha": invoker_sha,
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "job_count": len(jobs),
    "status_counts": counts,
    "jobs": jobs,
}
(batch_dir / "summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True))

lines = [
    f"# Invoker benchmark batch {batch_id}",
    "",
    f"- Invoker SHA: `{invoker_sha}`",
    f"- Jobs collected: {len(jobs)}",
]
for key in sorted(counts):
    lines.append(f"- {key}: {counts[key]}")
(batch_dir / "summary.md").write_text("\n".join(lines) + "\n")
PY

emit_args=("$BENCHMARK_ROOT/bin/emit-mixpanel-events.sh" --batch-dir "$BATCH_DIR")
if [[ "$EMIT_MIXPANEL" -eq 1 ]]; then
  emit_args+=(--emit)
fi
"${emit_args[@]}"

log "summary=$BATCH_DIR/summary.md"
exit "$status"
