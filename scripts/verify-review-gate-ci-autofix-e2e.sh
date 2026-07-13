#!/usr/bin/env bash
# Real GitHub E2E for review-gate CI auto-fix.
#
# This intentionally talks to https://github.com/EdbertChan/test-playground.
# It uses an isolated Invoker DB/config and creates a temporary external-review
# workflow whose PR is expected to have a failing CI check that the configured
# auto-fix agent can repair.
#
# Required:
#   - gh authenticated with permission to create/update PRs in EdbertChan/test-playground
#   - git push permission to EdbertChan/test-playground
#   - an auto-fix-capable agent available on PATH (default: codex)
#
# Optional:
#   INVOKER_REVIEW_GATE_E2E_REPO_URL      default: https://github.com/EdbertChan/test-playground.git
#   INVOKER_REVIEW_GATE_E2E_REPO_NWO      default: EdbertChan/test-playground
#   INVOKER_REVIEW_GATE_E2E_BASE_BRANCH  default: main
#   INVOKER_REVIEW_GATE_E2E_AGENT        default: codex
#   INVOKER_REVIEW_GATE_E2E_TIMEOUT      default: 900
#   INVOKER_REVIEW_GATE_E2E_KEEP_TMP     set 1 to keep temp DB/config/plan
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_URL="${INVOKER_REVIEW_GATE_E2E_REPO_URL:-https://github.com/EdbertChan/test-playground.git}"
REPO_NWO="${INVOKER_REVIEW_GATE_E2E_REPO_NWO:-EdbertChan/test-playground}"
BASE_BRANCH="${INVOKER_REVIEW_GATE_E2E_BASE_BRANCH:-main}"
AGENT="${INVOKER_REVIEW_GATE_E2E_AGENT:-codex}"
TIMEOUT_SECONDS="${INVOKER_REVIEW_GATE_E2E_TIMEOUT:-900}"
BRANCH_SUFFIX="$(date +%Y%m%d%H%M%S)-$$"
FEATURE_BRANCH="invoker/review-gate-ci-autofix-e2e-$BRANCH_SUFFIX"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/invoker-rg-ci-e2e.XXXXXX")"
CONFIG="$TMP_ROOT/config.json"
PLAN="$TMP_ROOT/review-gate-ci-autofix.yaml"
DB_DIR="$TMP_ROOT/db"
RUN_LOG="$TMP_ROOT/headless-run.log"
FAKE_STATUS_CONTEXT="invoker/fake-ci"
FAKE_STATUS_DESCRIPTION="Change invoker-autofix-ci.txt to contain exactly pass."
run_pid=""

cleanup() {
  if [ -n "$run_pid" ] && kill -0 "$run_pid" >/dev/null 2>&1; then
    kill "$run_pid" >/dev/null 2>&1 || true
    wait "$run_pid" >/dev/null 2>&1 || true
  fi
  if [ "${INVOKER_REVIEW_GATE_E2E_KEEP_TMP:-0}" = "1" ]; then
    echo "Keeping temp root: $TMP_ROOT"
    return
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

if ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: gh is required" >&2
  exit 127
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "ERROR: gh is not authenticated" >&2
  exit 1
fi

mkdir -p "$DB_DIR"
cat >"$CONFIG" <<JSON
{
  "defaultBranch": "$BASE_BRANCH",
  "autoFixRetries": 1,
  "autoApproveAIFixes": true,
  "autoFixAgent": "$AGENT",
  "autoFixCi": true
}
JSON

cat >"$PLAN" <<YAML
name: "Review gate CI auto-fix E2E"
repoUrl: "$REPO_URL"
onFinish: none
mergeMode: external_review
featureBranch: "$FEATURE_BRANCH"
baseBranch: "$BASE_BRANCH"

tasks:
  - id: rg-ci-autofix-seed
    description: "Create a PR state that the test-playground CI should reject until auto-fix repairs it"
    command: |
      printf 'fail\n' > invoker-autofix-ci.txt
      git add invoker-autofix-ci.txt
    dependencies: []
YAML

export INVOKER_DB_DIR="$DB_DIR"
export INVOKER_REPO_CONFIG_PATH="$CONFIG"
export INVOKER_HEADLESS_STANDALONE=1
export INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS="${INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS:-30000}"

echo "==> Temp root: $TMP_ROOT"
echo "==> Repo: $REPO_URL"
echo "==> Feature branch: $FEATURE_BRANCH"
echo "==> Config: $CONFIG"
echo "==> Plan: $PLAN"
echo "==> Headless run log: $RUN_LOG"

"$ROOT/run.sh" --headless run "$PLAN" --wait-for-approval >"$RUN_LOG" 2>&1 &
run_pid="$!"

deadline=$((SECONDS + TIMEOUT_SECONDS))
review_url=""
while [ "$SECONDS" -lt "$deadline" ]; do
  if ! kill -0 "$run_pid" >/dev/null 2>&1; then
    echo "ERROR: headless run exited before creating a review PR" >&2
    cat "$RUN_LOG" >&2
    exit 1
  fi
  tasks_json="$("$ROOT/run.sh" --headless query tasks --output json 2>/dev/null || true)"
  review_url="$(node -e '
function parseQuery(raw) {
  const text = raw || "[]";
  const arrayAt = text.lastIndexOf("\n[");
  if (arrayAt >= 0) return JSON.parse(text.slice(arrayAt + 1));
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) return JSON.parse(trimmed);
  return [];
}
let data;
try {
  data = parseQuery(process.argv[1]);
} catch {
  process.exit(0);
}
const tasks = Array.isArray(data) ? data : data.tasks || [];
const merge = tasks.find((t) => t.config && t.config.isMergeNode);
process.stdout.write(merge?.execution?.reviewUrl || "");
' "$tasks_json")"
  if [ -n "$review_url" ]; then
    break
  fi
  sleep 5
done

if [ -z "$review_url" ]; then
  echo "ERROR: review gate PR was not created before timeout" >&2
  exit 1
fi

echo "==> Review PR: $review_url"
pr_number="${review_url##*/}"
initial_head_sha="$(gh pr view "$pr_number" --repo "$REPO_NWO" --json headRefOid --jq '.headRefOid')"
if [ -z "$initial_head_sha" ]; then
  echo "ERROR: failed to read initial PR head SHA" >&2
  exit 1
fi

echo "==> Posting fake failing CI status on $initial_head_sha"
gh api "repos/$REPO_NWO/statuses/$initial_head_sha" \
  -f state=failure \
  -f context="$FAKE_STATUS_CONTEXT" \
  -f description="$FAKE_STATUS_DESCRIPTION" \
  -f target_url="$review_url" >/dev/null

echo "==> Waiting for review-gate CI auto-fix to run"

success_posted=0
while [ "$SECONDS" -lt "$deadline" ]; do
  if ! kill -0 "$run_pid" >/dev/null 2>&1; then
    echo "ERROR: headless run exited before fake CI passed" >&2
    cat "$RUN_LOG" >&2
    exit 1
  fi
  current_head_sha="$(gh pr view "$pr_number" --repo "$REPO_NWO" --json headRefOid --jq '.headRefOid' 2>/dev/null || true)"
  if [ "$success_posted" = "0" ] && [ -n "$current_head_sha" ] && [ "$current_head_sha" != "$initial_head_sha" ]; then
    fixed_content="$(
      gh api "repos/$REPO_NWO/contents/invoker-autofix-ci.txt?ref=$current_head_sha" --jq '.content' 2>/dev/null \
        | { base64 --decode 2>/dev/null || base64 -D 2>/dev/null; } \
        || true
    )"
    if [ "$fixed_content" = "pass" ]; then
      echo "==> Posting fake successful CI status on $current_head_sha"
      gh api "repos/$REPO_NWO/statuses/$current_head_sha" \
        -f state=success \
        -f context="$FAKE_STATUS_CONTEXT" \
        -f description="invoker-autofix-ci.txt contains pass" \
        -f target_url="$review_url" >/dev/null
      success_posted=1
    else
      echo "==> New head $current_head_sha does not satisfy fake CI yet"
      gh api "repos/$REPO_NWO/statuses/$current_head_sha" \
        -f state=failure \
        -f context="$FAKE_STATUS_CONTEXT" \
        -f description="$FAKE_STATUS_DESCRIPTION" \
        -f target_url="$review_url" >/dev/null
      initial_head_sha="$current_head_sha"
    fi
  fi

  tasks_json="$("$ROOT/run.sh" --headless query tasks --output json 2>/dev/null || true)"
  node -e '
function parseQuery(raw) {
  const text = raw || "[]";
  const arrayAt = text.lastIndexOf("\n[");
  if (arrayAt >= 0) return JSON.parse(text.slice(arrayAt + 1));
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) return JSON.parse(trimmed);
  return [];
}
let data;
try {
  data = parseQuery(process.argv[1]);
} catch {
  process.exit(2);
}
const tasks = Array.isArray(data) ? data : data.tasks || [];
const merge = tasks.find((t) => t.config && t.config.isMergeNode);
if (!merge) process.exit(1);
const status = merge.status;
const reviewStatus = merge.execution?.reviewStatus || "";
console.log(`merge=${status} reviewStatus=${reviewStatus}`);
if (process.argv[2] === "1" && (status === "awaiting_approval" || status === "review_ready" || status === "completed")) {
  process.exit(0);
}
process.exit(2);
' "$tasks_json" "$success_posted" && exit 0
  sleep 10
done

echo "ERROR: review-gate CI auto-fix did not complete before timeout" >&2
echo "PR: $review_url" >&2
exit 1
