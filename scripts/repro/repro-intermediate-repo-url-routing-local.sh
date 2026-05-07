#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

TMP_DIR="$(mktemp -d)"
DB_DIR="$TMP_DIR/db"
ORIGIN_BARE="$TMP_DIR/remotes/origin/Invoker.git"
INTERMEDIATE_BARE="$TMP_DIR/remotes/intermediate/test-playground.git"
SEED_REPO="$TMP_DIR/seed"
PLAN_TMP="$TMP_DIR/plan.yaml"
CFG_PATH="$TMP_DIR/config.json"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/remotes/origin" "$TMP_DIR/remotes/intermediate" "$DB_DIR"

echo "[setup] creating isolated origin + intermediate remotes"
git init --bare "$ORIGIN_BARE" >/dev/null
git init --bare "$INTERMEDIATE_BARE" >/dev/null

echo "[setup] seeding master in both remotes"
git clone "$ORIGIN_BARE" "$SEED_REPO" >/dev/null
git -C "$SEED_REPO" config user.email "test@example.com"
git -C "$SEED_REPO" config user.name "test-user"
echo "seed" > "$SEED_REPO/README.md"
git -C "$SEED_REPO" add README.md
git -C "$SEED_REPO" commit -m "seed" >/dev/null
git -C "$SEED_REPO" push origin master >/dev/null
git -C "$SEED_REPO" remote add intermediate "$INTERMEDIATE_BARE"
git -C "$SEED_REPO" push intermediate master >/dev/null

ORIGIN_MASTER_BEFORE="$(git --git-dir "$ORIGIN_BARE" rev-parse refs/heads/master)"
INTERMEDIATE_MASTER_BEFORE="$(git --git-dir "$INTERMEDIATE_BARE" rev-parse refs/heads/master)"
ORIGIN_URI="file://$ORIGIN_BARE"
INTERMEDIATE_URI="file://$INTERMEDIATE_BARE"

echo "[setup] writing custom plan with guaranteed file changes"
cat > "$PLAN_TMP" <<EOF
name: Intermediate Repo URL Local Proof
repoUrl: $ORIGIN_URI
intermediateRepoUrl: $INTERMEDIATE_URI
onFinish: merge
baseBranch: master
featureBranch: plan/intermediate-routing-proof
tasks:
  - id: local-proof-a
    description: add proof line A
    command: |
      echo "proof-a" >> ROUTING_PROOF.txt
      git add ROUTING_PROOF.txt
  - id: local-proof-b
    description: add proof line B
    dependencies: [local-proof-a]
    command: |
      echo "proof-b" >> ROUTING_PROOF.txt
      git add ROUTING_PROOF.txt
EOF

cat > "$CFG_PATH" <<'JSON'
{
  "workspaceRoot": "/tmp",
  "remoteTargets": []
}
JSON

cd "$ROOT"
echo "[run] executing headless plan"
INVOKER_DB_DIR="$DB_DIR" \
INVOKER_REPO_CONFIG_PATH="$CFG_PATH" \
INVOKER_HEADLESS_STANDALONE=1 \
./run.sh --headless run "$PLAN_TMP" >/dev/null

TASKS_JSON="$(
  INVOKER_DB_DIR="$DB_DIR" \
  INVOKER_REPO_CONFIG_PATH="$CFG_PATH" \
  INVOKER_HEADLESS_STANDALONE=1 \
  ./run.sh --headless query tasks --output json
)"

TASKS_FILE="$TMP_DIR/tasks.json"
printf '%s\n' "$TASKS_JSON" > "$TASKS_FILE"

MERGE_ID="$(
  python3 - <<'PY' "$TASKS_FILE"
import json
import sys

tasks = json.loads(open(sys.argv[1], encoding="utf-8").read())
merge = [t.get("id", "") for t in tasks if (t.get("config") or {}).get("isMergeNode", False)]
print(merge[0] if merge else "")
PY
)"

if [[ -z "$MERGE_ID" ]]; then
  echo "FAIL: could not find merge gate task id in task records" >&2
  exit 1
fi

NON_MERGE_BRANCHES="$(
  python3 - <<'PY' "$TASKS_FILE"
import json
import sys

tasks = json.loads(open(sys.argv[1], encoding="utf-8").read())
branches = sorted({
    (task.get("execution") or {}).get("branch", "")
    for task in tasks
    if not ((task.get("config") or {}).get("isMergeNode", False))
})
print("\n".join([b for b in branches if b]))
PY
)"

if [[ -z "$NON_MERGE_BRANCHES" ]]; then
  echo "FAIL: no non-merge task branches captured from execution records" >&2
  exit 1
fi

echo "[run] approving merge gate to trigger final publish ($MERGE_ID)"
INVOKER_DB_DIR="$DB_DIR" \
INVOKER_REPO_CONFIG_PATH="$CFG_PATH" \
INVOKER_HEADLESS_STANDALONE=1 \
./run.sh --headless approve "$MERGE_ID" >/dev/null

echo "[verify] non-merge branches route to intermediate only"
FAIL=0
while IFS= read -r branch; do
  [[ -z "$branch" ]] && continue

  set +e
  git --git-dir "$INTERMEDIATE_BARE" show-ref --verify --quiet "refs/heads/$branch"
  INTERMEDIATE_STATUS=$?
  git --git-dir "$ORIGIN_BARE" show-ref --verify --quiet "refs/heads/$branch"
  ORIGIN_STATUS=$?
  set -e

  echo "  branch=$branch intermediate=$INTERMEDIATE_STATUS origin=$ORIGIN_STATUS"
  if [[ $INTERMEDIATE_STATUS -ne 0 || $ORIGIN_STATUS -eq 0 ]]; then
    FAIL=1
  fi
done <<< "$NON_MERGE_BRANCHES"

ORIGIN_MASTER_AFTER="$(git --git-dir "$ORIGIN_BARE" rev-parse refs/heads/master)"
INTERMEDIATE_MASTER_AFTER="$(git --git-dir "$INTERMEDIATE_BARE" rev-parse refs/heads/master)"

echo "[verify] final merge publish lands on origin/master only"
echo "  origin/master:       $ORIGIN_MASTER_BEFORE -> $ORIGIN_MASTER_AFTER"
echo "  intermediate/master: $INTERMEDIATE_MASTER_BEFORE -> $INTERMEDIATE_MASTER_AFTER"

if [[ "$ORIGIN_MASTER_BEFORE" == "$ORIGIN_MASTER_AFTER" ]]; then
  echo "FAIL: origin/master did not advance; expected merge-node publish to origin" >&2
  exit 1
fi

if [[ "$INTERMEDIATE_MASTER_BEFORE" != "$INTERMEDIATE_MASTER_AFTER" ]]; then
  echo "FAIL: intermediate/master changed; merge-node publish should not target intermediate" >&2
  exit 1
fi

if [[ $FAIL -ne 0 ]]; then
  echo "FAIL: one or more non-merge branches were not routed to intermediate-only" >&2
  exit 1
fi

echo "PASS: non-merge branches pushed to intermediate, final merge publish pushed to origin"
