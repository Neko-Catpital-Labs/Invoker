#!/usr/bin/env bash
# Production recreate supervisor for external failure recovery.
#
# Replaces the previously ad hoc /tmp supervisor with a repo-supported
# recovery path. Each iteration:
#   1. (Once, at start) Syncs `refs/heads/master` to the SHA pointed at by
#      `refs/remotes/upstream/master` using `git update-ref`. The script
#      never checks out master, never resets the current branch, and never
#      mutates pooled mirror clones — this is intentionally a host-side
#      ref-only sync.
#   2. Queries all workflows headlessly.
#   3. Queues `recreate <wf-id>` for every workflow whose status is `failed`.
#   4. Tracks the set of incomplete (not-`completed`) workflows. If the
#      set is unchanged for `PROD_RECREATE_STALL_CYCLES` cycles in a row,
#      queues `recreate <wf-id>` for every incomplete workflow and resets
#      the stall counter.
#   5. Sleeps `PROD_RECREATE_INTERVAL_SECONDS` and repeats, up to
#      `PROD_RECREATE_MAX_CYCLES` total cycles (0 = run forever).
#
# Environment knobs:
#   PROD_RECREATE_INTERVAL_SECONDS   Sleep between cycles. Default: 300.
#   PROD_RECREATE_MAX_CYCLES         Max cycles before exit. 0 = loop
#                                    forever. Default: 0.
#   PROD_RECREATE_STALL_CYCLES       Cycles of unchanged incomplete set
#                                    before stall recreate. Default: 6.
#   PROD_RECREATE_UPSTREAM_REMOTE    Upstream remote name. Default: upstream.
#   PROD_RECREATE_UPSTREAM_BRANCH    Upstream branch name. Default: master.
#
# Test overrides (used by scripts/test-prod-recreate-supervisor.sh):
#   INVOKER_PROD_RECREATE_REPO          Override repo root.
#   INVOKER_PROD_RECREATE_GIT_BIN       Override git binary path.
#   INVOKER_PROD_RECREATE_HEADLESS_CMD  Override headless dispatcher. When
#                                       set, the script invokes
#                                         "$cmd" query-workflows
#                                         "$cmd" recreate <wf-id>
#                                       instead of running the real
#                                       Electron headless transport.
set -euo pipefail

REPO_ROOT="${INVOKER_PROD_RECREATE_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
GIT_BIN="${INVOKER_PROD_RECREATE_GIT_BIN:-git}"
HEADLESS_CMD="${INVOKER_PROD_RECREATE_HEADLESS_CMD:-}"

INTERVAL_SECONDS="${PROD_RECREATE_INTERVAL_SECONDS:-300}"
MAX_CYCLES="${PROD_RECREATE_MAX_CYCLES:-0}"
STALL_CYCLES="${PROD_RECREATE_STALL_CYCLES:-6}"
UPSTREAM_REMOTE="${PROD_RECREATE_UPSTREAM_REMOTE:-upstream}"
UPSTREAM_BRANCH="${PROD_RECREATE_UPSTREAM_BRANCH:-master}"

for var in INTERVAL_SECONDS MAX_CYCLES STALL_CYCLES; do
  value="${!var}"
  if ! [[ "$value" =~ ^[0-9]+$ ]]; then
    echo "ERROR: $var must be a non-negative integer (got '$value')" >&2
    exit 2
  fi
done

if [[ "$INTERVAL_SECONDS" -lt 1 ]]; then
  echo "ERROR: PROD_RECREATE_INTERVAL_SECONDS must be >= 1" >&2
  exit 2
fi

# Phase 1: sync local refs/heads/master to upstream without touching the
# working tree, current branch, or any pooled mirror clones.
sync_master_ref() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] phase=sync-master-ref remote=${UPSTREAM_REMOTE} branch=${UPSTREAM_BRANCH}"
  "$GIT_BIN" -C "$REPO_ROOT" fetch "$UPSTREAM_REMOTE" \
    "refs/heads/${UPSTREAM_BRANCH}:refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}"
  local sha
  sha="$("$GIT_BIN" -C "$REPO_ROOT" rev-parse "refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}")"
  if [[ -z "$sha" ]]; then
    echo "ERROR: empty SHA for refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}" >&2
    exit 1
  fi
  "$GIT_BIN" -C "$REPO_ROOT" update-ref "refs/heads/${UPSTREAM_BRANCH}" "$sha"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] phase=sync-master-ref result=updated sha=${sha}"
}

query_workflows_jsonl() {
  if [[ -n "$HEADLESS_CMD" ]]; then
    "$HEADLESS_CMD" query-workflows
    return
  fi
  # shellcheck source=scripts/headless-lib.sh
  source "$REPO_ROOT/scripts/headless-lib.sh"
  headless_query query workflows --output jsonl
}

queue_recreate() {
  local wf_id="$1"
  if [[ -n "$HEADLESS_CMD" ]]; then
    "$HEADLESS_CMD" recreate "$wf_id"
    return
  fi
  # shellcheck source=scripts/headless-lib.sh
  source "$REPO_ROOT/scripts/headless-lib.sh"
  headless_mutation --no-track recreate "$wf_id"
}

bucket_workflows() {
  WORKFLOWS_JSONL="$1" python3 - <<'PY'
import json
import os

raw = os.environ.get("WORKFLOWS_JSONL", "")
failed = []
incomplete = []
for line in raw.splitlines():
    line = line.strip()
    if not line or not line.startswith("{"):
        continue
    try:
        wf = json.loads(line)
    except json.JSONDecodeError:
        continue
    wid = wf.get("id")
    status = wf.get("status")
    if not wid:
        continue
    if status == "failed":
        failed.append(wid)
    if status != "completed":
        incomplete.append(wid)

print("FAILED")
for wid in failed:
    print(wid)
print("INCOMPLETE")
for wid in incomplete:
    print(wid)
PY
}

PREV_INCOMPLETE_SIGNATURE=""
STALL_COUNTER=0

run_cycle() {
  local cycle="$1"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] cycle=${cycle} phase=query"

  local raw
  set +e
  raw="$(query_workflows_jsonl)"
  local query_rc=$?
  set -e
  if [[ "$query_rc" -ne 0 ]]; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] cycle=${cycle} phase=query result=failed rc=${query_rc}" >&2
    return 0
  fi

  local buckets failed_ids="" incomplete_ids="" section=""
  buckets="$(bucket_workflows "$raw")"
  while IFS= read -r line; do
    case "$line" in
      FAILED) section=failed ;;
      INCOMPLETE) section=incomplete ;;
      "") ;;
      *)
        if [[ "$section" == failed ]]; then
          failed_ids+="$line"$'\n'
        elif [[ "$section" == incomplete ]]; then
          incomplete_ids+="$line"$'\n'
        fi
        ;;
    esac
  done <<<"$buckets"

  local failed_count incomplete_count
  failed_count="$(printf '%s' "$failed_ids" | grep -c . || true)"
  incomplete_count="$(printf '%s' "$incomplete_ids" | grep -c . || true)"

  if [[ -n "$failed_ids" ]]; then
    while IFS= read -r wf_id; do
      [[ -z "$wf_id" ]] && continue
      echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] cycle=${cycle} phase=recreate-failed wf=${wf_id}"
      if ! queue_recreate "$wf_id"; then
        echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] cycle=${cycle} phase=recreate-failed wf=${wf_id} result=dispatch-failed" >&2
      fi
    done <<<"$failed_ids"
  fi

  local incomplete_signature
  incomplete_signature="$(printf '%s' "$incomplete_ids" | sort | tr '\n' ',')"
  if [[ -n "$incomplete_signature" && "$incomplete_signature" == "$PREV_INCOMPLETE_SIGNATURE" ]]; then
    STALL_COUNTER=$((STALL_COUNTER + 1))
  else
    STALL_COUNTER=0
  fi
  PREV_INCOMPLETE_SIGNATURE="$incomplete_signature"

  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] cycle=${cycle} phase=summary failed=${failed_count} incomplete=${incomplete_count} stall=${STALL_COUNTER}/${STALL_CYCLES}"

  if [[ "$STALL_COUNTER" -ge "$STALL_CYCLES" && -n "$incomplete_ids" ]]; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] cycle=${cycle} phase=stall-recreate-all incomplete=${incomplete_count}"
    while IFS= read -r wf_id; do
      [[ -z "$wf_id" ]] && continue
      echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] cycle=${cycle} phase=stall-recreate wf=${wf_id}"
      if ! queue_recreate "$wf_id"; then
        echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] cycle=${cycle} phase=stall-recreate wf=${wf_id} result=dispatch-failed" >&2
      fi
    done <<<"$incomplete_ids"
    STALL_COUNTER=0
  fi
}

sync_master_ref

cycle=0
while true; do
  cycle=$((cycle + 1))
  run_cycle "$cycle"

  if [[ "$MAX_CYCLES" -gt 0 && "$cycle" -ge "$MAX_CYCLES" ]]; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] reached MAX_CYCLES=${MAX_CYCLES}; exiting"
    break
  fi

  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] sleeping ${INTERVAL_SECONDS}s"
  sleep "$INTERVAL_SECONDS"
done
