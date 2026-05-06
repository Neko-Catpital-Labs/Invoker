#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLAN_SRC="$ROOT/plans/e2e-dry-run/group2-multi-task/2.3-parallel-success.yaml"

if [[ ! -f "$PLAN_SRC" ]]; then
  echo "Missing plan fixture: $PLAN_SRC" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
DB_DIR="$TMP_DIR/db"
UPSTREAM_BARE="$TMP_DIR/remotes/upstream/Invoker.git"
ORIGIN_BARE="$TMP_DIR/remotes/origin/Invoker.git"
SEED_REPO="$TMP_DIR/seed"
PLAN_TMP="$TMP_DIR/plan.yaml"
CFG_PATH="$TMP_DIR/config.json"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/remotes/upstream" "$TMP_DIR/remotes/origin" "$DB_DIR"

# Create isolated remotes to validate branch routing behavior.
git init --bare "$UPSTREAM_BARE" >/dev/null
git init --bare "$ORIGIN_BARE" >/dev/null

# Seed both remotes with the same master baseline.
git clone "$UPSTREAM_BARE" "$SEED_REPO" >/dev/null
git -C "$SEED_REPO" config user.email "test@example.com"
git -C "$SEED_REPO" config user.name "test-user"
echo "seed" > "$SEED_REPO/README.md"
git -C "$SEED_REPO" add README.md
git -C "$SEED_REPO" commit -m "seed" >/dev/null
git -C "$SEED_REPO" push origin master >/dev/null
git -C "$SEED_REPO" remote add fork "$ORIGIN_BARE"
git -C "$SEED_REPO" push fork master >/dev/null

# Route plan execution pushes to origin remote.
python3 - <<'PY' "$PLAN_SRC" "$PLAN_TMP" "$ORIGIN_BARE"
import pathlib
import sys

src = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
dst = pathlib.Path(sys.argv[2])
origin_uri = pathlib.Path(sys.argv[3]).as_uri()

out = []
for line in src.splitlines():
    if line.lstrip().startswith("repoUrl:"):
        out.append(f"repoUrl: {origin_uri}")
    else:
        out.append(line)

dst.write_text("\n".join(out) + "\n", encoding="utf-8")
PY

cat > "$CFG_PATH" <<'JSON'
{
  "workspaceRoot": "/tmp",
  "remoteTargets": []
}
JSON

cd "$ROOT"
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

BRANCHES="$(
  python3 - <<'PY' "$TASKS_FILE"
import json
import sys

tasks = json.loads(open(sys.argv[1], encoding="utf-8").read())
branches = sorted({
    (task.get("execution") or {}).get("branch", "")
    for task in tasks
    if "/e2e-g223-task" in ((task.get("execution") or {}).get("branch") or "")
})
print("\n".join([b for b in branches if b]))
PY
)"

if [[ -z "$BRANCHES" ]]; then
  echo "FAIL: no DAG task branches were captured from execution records" >&2
  exit 1
fi

FAIL=0
while IFS= read -r branch; do
  [[ -z "$branch" ]] && continue

  set +e
  git --git-dir "$ORIGIN_BARE" show-ref --verify --quiet "refs/heads/$branch"
  ORIGIN_STATUS=$?
  git --git-dir "$UPSTREAM_BARE" show-ref --verify --quiet "refs/heads/$branch"
  UPSTREAM_STATUS=$?
  set -e

  echo "branch=$branch origin=$ORIGIN_STATUS upstream=$UPSTREAM_STATUS"

  # Must exist in origin and must not exist in upstream.
  if [[ $ORIGIN_STATUS -ne 0 || $UPSTREAM_STATUS -eq 0 ]]; then
    FAIL=1
  fi
done <<< "$BRANCHES"

if [[ $FAIL -ne 0 ]]; then
  echo "FAIL: expected all DAG task branches only on origin (not upstream)" >&2
  exit 1
fi

echo "PASS: DAG task branches are pushed to origin and absent from upstream"
