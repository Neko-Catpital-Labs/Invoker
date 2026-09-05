#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if ! command -v invoker-cli >/dev/null 2>&1; then
  echo "invoker-cli not on PATH; cannot run this repro" >&2
  exit 2
fi

LIVE_ID="$(invoker-cli query workflows --output json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d[0]["id"] if d else "")')"
if [ -z "$LIVE_ID" ]; then
  echo "No live workflows found via invoker-cli; cannot run this repro against a real target" >&2
  exit 2
fi

echo "Target: a real, currently-live workflow ($LIVE_ID) known to invoker-cli."
echo "Exercising submit-workflow-chain.sh's own resolve_workflow_feature_branch() against it, with a tight 5s (25-attempt) budget."
echo

source scripts/submit-workflow-chain.sh

BACKEND="live"
START_MS="$(now_ms)"
RESULT="$(resolve_workflow_feature_branch "$LIVE_ID" 2>&1)"
STATUS=$?
ELAPSED_MS=$(( $(now_ms) - START_MS ))

echo "resolve_workflow_feature_branch exit=$STATUS elapsedMs=$ELAPSED_MS"
echo "  output: $RESULT"

if [ "$STATUS" -eq 0 ] && [ "$ELAPSED_MS" -lt 5000 ]; then
  echo
  echo "PASS: resolved the real featureBranch quickly via the live owner."
  exit 0
fi
echo
echo "FAIL: did not resolve quickly (still hitting a disconnected backend, or genuinely slow)."
exit 1
