#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

REPO="Neko-Catpital-Labs/Invoker"
STATE_FILE="${HOME}/.invoker/mergify-admin-requeue-state.jsonl"
RUN_BATTLE=true
PRS=()

usage() {
  cat <<'EOF'
Usage: bash loop-driver.sh [options]

One loop pass helper for the mergify_admin_requeue worker battle-test.
It never writes to real PRs.

Options:
  --skip-battle         Only print live target + ledger status.
  --pr <number>         Also run worker --dry-run for this PR. Repeatable.
  --state-file <path>   Override ledger path.
  --repo <owner/repo>   Override repo. Default: Neko-Catpital-Labs/Invoker.
  --help                Show this message.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-battle)
      RUN_BATTLE=false
      shift
      ;;
    --pr)
      [[ $# -ge 2 ]] || { echo "Missing value for --pr" >&2; exit 1; }
      PRS+=("$2")
      shift 2
      ;;
    --state-file)
      [[ $# -ge 2 ]] || { echo "Missing value for --state-file" >&2; exit 1; }
      STATE_FILE="$2"
      shift 2
      ;;
    --repo)
      [[ $# -ge 2 ]] || { echo "Missing value for --repo" >&2; exit 1; }
      REPO="$2"
      shift 2
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

for pr in "${PRS[@]}"; do
  if ! [[ "$pr" =~ ^[1-9][0-9]*$ ]]; then
    echo "Invalid --pr value: $pr" >&2
    exit 1
  fi
done

if [[ -n "$STATE_FILE" && ! -f "$STATE_FILE" ]]; then
  echo "WARN: ledger file not found: $STATE_FILE" >&2
fi

admin_json="$(gh pr list --repo "$REPO" --state open --label admin-bypass --json number,title,labels,mergeStateStatus,updatedAt,url)"
dequeued_json="$(gh pr list --repo "$REPO" --state open --label dequeued --json number,title,labels,mergeStateStatus,updatedAt,url)"

targets_json="$(python3 - "$admin_json" "$dequeued_json" <<'PY'
import json
import sys

admin = json.loads(sys.argv[1])
dequeued = json.loads(sys.argv[2])
merged = {}
TARGET_LABELS = {"admin-bypass", "dequeued"}
for item in admin + dequeued:
    labels = {
        label.get("name", "")
        for label in item.get("labels", [])
        if isinstance(label, dict)
    }
    actual_target_labels = sorted(label for label in labels if label in TARGET_LABELS)
    if not actual_target_labels:
        continue
    number = item["number"]
    row = merged.setdefault(number, {
        "number": number,
        "title": item.get("title", ""),
        "mergeStateStatus": item.get("mergeStateStatus", ""),
        "updatedAt": item.get("updatedAt", ""),
        "url": item.get("url", ""),
        "labels": set(),
    })
    row["labels"].update(actual_target_labels)
for row in merged.values():
    row["labels"] = sorted(row["labels"])
print(json.dumps(sorted(merged.values(), key=lambda row: row["number"])))
PY
)"

echo "== loop context =="
echo "pwd: $PWD"
echo "branch: $(git branch --show-current)"
echo "repo: $REPO"
echo "ledger: $STATE_FILE"
echo

echo "== live worker targets (admin-bypass or dequeued) =="
python3 - "$targets_json" <<'PY'
import json
import sys

targets = json.loads(sys.argv[1])
if not targets:
    print("none")
    raise SystemExit(0)
for row in targets:
    labels = ",".join(row.get("labels", [])) or "-"
    print(f"PR #{row['number']}: mergeStateStatus={row.get('mergeStateStatus') or '-'} labels={labels} {row.get('url') or ''}")
    print(f"  title: {row.get('title') or ''}")
PY

echo

echo "== ledger fail-condition summary (3+ attempts on same pr/head/kind/key) =="
python3 - "$targets_json" "$STATE_FILE" <<'PY'
import json
import pathlib
import sys
from collections import Counter

try:
    targets = json.loads(sys.argv[1])
except json.JSONDecodeError:
    print("could not parse targets")
    raise SystemExit(0)

path = pathlib.Path(sys.argv[2])
target_numbers = {row["number"] for row in targets}
if not path.exists():
    print(f"ledger missing: {path}")
    raise SystemExit(0)

counts = Counter()
for raw in path.read_text().splitlines():
    if not raw.strip():
        continue
    try:
        row = json.loads(raw)
    except json.JSONDecodeError:
        continue
    pr = row.get("pr")
    if pr not in target_numbers:
        continue
    counts[(pr, row.get("headSha"), row.get("kind"), row.get("key"))] += 1

failures = [item for item in counts.items() if item[1] >= 3]
if not failures:
    print("none")
    raise SystemExit(0)
for (pr, head, kind, key), count in sorted(failures):
    short = (head or "")[:12]
    print(f"FAIL_CONDITION PR #{pr}: attempts={count} kind={kind} key={key} headSha={short}")
PY

if ((${#PRS[@]} > 0)); then
  echo
  echo "== worker dry-run snapshots =="
  for pr in "${PRS[@]}"; do
    echo "-- PR #$pr --"
    ledger_copy="$(mktemp /tmp/mergify-admin-requeue-ledger.XXXXXX.jsonl)"
    if [[ -f "$STATE_FILE" ]]; then
      cp "$STATE_FILE" "$ledger_copy"
    else
      : > "$ledger_copy"
    fi
    python3 scripts/mergify_admin_requeue.py --dry-run --once --repo "$REPO" --state-file "$ledger_copy" --pr "$pr"
    rm -f "$ledger_copy"
  done
fi

battle_rc=0
if [[ "$RUN_BATTLE" == true ]]; then
  echo
  echo "== local proxy checker =="
  if bash ./battle-loop.sh; then
    echo "PASS: battle-loop.sh"
  else
    battle_rc=$?
    echo "FAIL: battle-loop.sh (exit $battle_rc)"
  fi
fi

echo

echo "== worker-only reminder =="
echo "Success means the worker lands admin-bypass/dequeued PRs by itself."
echo "Manual PR edits, label changes, requeues, rebases, splits, or force-pushes do not count."
exit "$battle_rc"
