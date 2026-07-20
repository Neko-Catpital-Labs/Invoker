#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
REPO="Neko-Catpital-Labs/Invoker"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-mergify-admin-stack-expansion.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

cat > "$TMP/bin/gh" <<'PY'
#!/usr/bin/env python3
import json
import sys

HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
REQUIRED = [
    "build-artifacts",
    "quality / Dependency Cruise",
    "PR Body",
    "quality / TypeScript Types",
    "required-fast / Guardrails",
    "required-fast / Submit Workflow Chain",
    "UI Vitest",
]
REPO = "Neko-Catpital-Labs/Invoker"


def contexts():
    return {
        "contexts": {
            "nodes": [
                {
                    "__typename": "CheckRun",
                    "name": name,
                    "conclusion": "SUCCESS",
                    "status": "COMPLETED",
                    "completedAt": "2026-07-19T00:00:00Z",
                    "startedAt": "2026-07-19T00:00:00Z",
                    "detailsUrl": "https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/1/job/2",
                    "checkSuite": {"commit": {"oid": HEAD}},
                }
                for name in REQUIRED
            ]
        }
    }


def pr(number):
    if number == 100:
        base = "master"
        head = "stack/bottom"
        labels = ["dequeued"]
    elif number == 101:
        base = "stack/bottom"
        head = "stack/top"
        labels = ["admin-bypass", "dequeued"]
    else:
        raise SystemExit(f"unexpected PR #{number}")
    return {
        "number": number,
        "title": f"Stack PR {number}",
        "url": f"https://github.com/{REPO}/pull/{number}",
        "isDraft": False,
        "state": "OPEN",
        "baseRefName": base,
        "headRefName": head,
        "headRefOid": HEAD,
        "mergeStateStatus": "CLEAN",
        "mergeable": "MERGEABLE",
        "labels": {"nodes": [{"name": label} for label in labels]},
        "reviewThreads": {"pageInfo": {"hasNextPage": False}, "nodes": []},
        "statusCheckRollup": contexts(),
    }


args = sys.argv[1:]
if args[:2] == ["pr", "list"]:
    if "--label" not in args or "admin-bypass" not in args:
        print(f"expected admin-bypass label seed, got: {args}", file=sys.stderr)
        raise SystemExit(2)
    print(json.dumps([pr(101)]))
    raise SystemExit(0)

if args[:2] == ["api", "graphql"]:
    number = 0
    for arg in args:
        if arg.startswith("number="):
            number = int(arg.split("=", 1)[1])
    print(json.dumps({"data": {"repository": {"pullRequest": pr(number)}}}))
    raise SystemExit(0)

if args[:2] == ["api", f"repos/{REPO}/issues/101/comments"]:
    body = '<!-- mergify-stack-data: {"stack_id":"stack-expansion","pull_numbers_bottom_to_top":[100,101]} -->'
    print(json.dumps([{"id": "stack-meta", "created_at": "2026-07-19T00:00:00Z", "body": body}]))
    raise SystemExit(0)

if args[:2] == ["api", f"repos/{REPO}/issues/100/comments"]:
    print("[]")
    raise SystemExit(0)

print(f"unexpected gh args: {args}", file=sys.stderr)
raise SystemExit(2)
PY
chmod +x "$TMP/bin/gh"

export PATH="$TMP/bin:$PATH"
out="$(python3 scripts/mergify_admin_requeue.py --dry-run --once --repo "$REPO" --author EdbertChan --state-file "$TMP/ledger.jsonl")"
printf '%s\n' "$out"

case "$out" in
  *"DRY-RUN comment-admin-bypass-nudge PR #100"*) ;;
  *) echo "[repro] expected stack expansion to nudge for unlabeled bottom PR #100" >&2; exit 1 ;;
esac

case "$out" in
  *"add-admin-bypass-label"*) echo "[repro] saw forbidden auto-label path for unlabeled bottom PR #100" >&2; exit 1 ;;
esac

case "$out" in
  *"no current bottom"*) echo "[repro] saw pre-fix failure mode: upper PR was processed without its bottom" >&2; exit 1 ;;
esac

echo "[repro] passed"
