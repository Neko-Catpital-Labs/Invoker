#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/e2e-dry-run/lib/common.sh"

invoker_e2e_init
trap invoker_e2e_cleanup EXIT
invoker_e2e_ensure_app_built

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

PLAN_PATH="$(mktemp "${TMPDIR:-/tmp}/invoker-e2e-adapter-validation.XXXXXX.yaml")"
SUBMIT_LOG="$(mktemp "${TMPDIR:-/tmp}/invoker-e2e-adapter-validation.XXXXXX.log")"
trap 'rm -f "$PLAN_PATH" "$SUBMIT_LOG"; invoker_e2e_cleanup' EXIT

cat > "$PLAN_PATH" <<'EOF'
name: e2e adapter validation
repoUrl: git@github.com:invoker/workflow-test.git
tasks:
  - id: adapter-validation
    description: Adapter validation seed workflow
    command: bash -lc 'exit 0'
EOF

echo "==> adapter validation: delete-all"
invoker_e2e_run_headless delete-all

echo "==> adapter validation: submit seed workflow"
invoker_e2e_submit_plan_capture "$PLAN_PATH" "$SUBMIT_LOG"
WF_ID="$(invoker_e2e_extract_workflow_id_from_log "$SUBMIT_LOG")"
if [[ -z "$WF_ID" ]]; then
  echo "FAIL: could not resolve workflow id from seed workflow submit" >&2
  cat "$SUBMIT_LOG" >&2 || true
  exit 1
fi

workflow_dep_count() {
  local workflow_id="$1"
  invoker_e2e_run_headless query workflows --output jsonl \
    | grep '^{' \
    | python3 -c 'import json, sys
wf_id = sys.argv[1]
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    row = json.loads(line)
    if row.get("id") == wf_id:
        deps = row.get("externalDependencies") or []
        print(len(deps))
        raise SystemExit(0)
print("-1")
' "$workflow_id"
}

echo "==> adapter validation: set a valid external dependency"
VALID_DEPS='[{"workflowId":"wf-upstream","taskId":"__merge__","requiredStatus":"completed","gatePolicy":"completed"}]'
invoker_e2e_run_headless set workflow "$WF_ID" externalDependencies "$VALID_DEPS"
if [[ "$(workflow_dep_count "$WF_ID")" != "1" ]]; then
  echo "FAIL: expected workflow to keep one valid external dependency after set workflow" >&2
  invoker_e2e_run_headless query workflows --output jsonl >&2 || true
  exit 1
fi

EMPTY_OUT="$(mktemp "${TMPDIR:-/tmp}/invoker-e2e-adapter-empty.XXXXXX.out")"
EMPTY_ERR="$(mktemp "${TMPDIR:-/tmp}/invoker-e2e-adapter-empty.XXXXXX.err")"
BAD_OUT="$(mktemp "${TMPDIR:-/tmp}/invoker-e2e-adapter-bad.XXXXXX.out")"
BAD_ERR="$(mktemp "${TMPDIR:-/tmp}/invoker-e2e-adapter-bad.XXXXXX.err")"
trap 'rm -f "$PLAN_PATH" "$SUBMIT_LOG" "$EMPTY_OUT" "$EMPTY_ERR" "$BAD_OUT" "$BAD_ERR"; invoker_e2e_cleanup' EXIT

set +e
invoker_e2e_run_headless set workflow "$WF_ID" externalDependencies '[]' >"$EMPTY_OUT" 2>"$EMPTY_ERR"
EMPTY_STATUS=$?
set -e
if [[ "$EMPTY_STATUS" -eq 0 ]]; then
  echo "FAIL: expected empty externalDependencies update to be rejected" >&2
  cat "$EMPTY_OUT" >&2 || true
  cat "$EMPTY_ERR" >&2 || true
  exit 1
fi
if ! grep -Fq 'externalDependencies must be non-empty when present' "$EMPTY_ERR" && ! grep -Fq 'externalDependencies must be non-empty when present' "$EMPTY_OUT"; then
  echo "FAIL: expected empty externalDependencies rejection message" >&2
  cat "$EMPTY_OUT" >&2 || true
  cat "$EMPTY_ERR" >&2 || true
  exit 1
fi

set +e
invoker_e2e_run_headless set workflow "$WF_ID" externalDependencies '[{"workflowId":"","taskId":"__merge__","requiredStatus":"completed","gatePolicy":"completed"}]' >"$BAD_OUT" 2>"$BAD_ERR"
BAD_STATUS=$?
set -e
if [[ "$BAD_STATUS" -eq 0 ]]; then
  echo "FAIL: expected malformed external dependency update to be rejected" >&2
  cat "$BAD_OUT" >&2 || true
  cat "$BAD_ERR" >&2 || true
  exit 1
fi
if ! grep -Fq 'externalDependencies[0]' "$BAD_ERR" && ! grep -Fq 'externalDependencies[0]' "$BAD_OUT"; then
  echo "FAIL: expected malformed external dependency rejection message" >&2
  cat "$BAD_OUT" >&2 || true
  cat "$BAD_ERR" >&2 || true
  exit 1
fi

if [[ "$(workflow_dep_count "$WF_ID")" != "1" ]]; then
  echo "FAIL: rejected workflow metadata update should not remove the existing dependency" >&2
  invoker_e2e_run_headless query workflows --output jsonl >&2 || true
  exit 1
fi

echo "adapter validation proof passed"
