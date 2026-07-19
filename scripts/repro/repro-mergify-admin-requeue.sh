#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-mergify-admin-requeue.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

cat > "$TMP/bin/gh" <<'PY'
#!/usr/bin/env python3
import json
import sys

HEAD = "c2532d229dbed2fd57419698c48d973001c78e9e"
REQUIRED = [
    "build-artifacts",
    "quality / Dependency Cruise",
    "PR Body",
    "quality / TypeScript Types",
    "required-fast / Guardrails",
    "required-fast / Vitest Workspace",
    "required-fast / Submit Workflow Chain",
    "UI Vitest",
    "e2e-proof / aggregate",
    "playwright / 1-of-6",
    "playwright / 2-of-6",
    "playwright / 3-of-6",
    "playwright / 4-of-6",
    "playwright / 5-of-6",
    "playwright / 6-of-6",
    "ssh / shard-30",
    "ssh / shard-31",
    "optional / Worktree Provisioning",
    "optional / Visual Proof Validate",
]


def contexts(number):
    nodes = []
    for name in REQUIRED:
        conclusion = "FAILURE" if number == 2606 and name == "PR Body" else "SUCCESS"
        nodes.append({
            "__typename": "CheckRun",
            "name": name,
            "conclusion": conclusion,
            "status": "COMPLETED",
            "completedAt": "2026-07-03T00:00:00Z",
            "startedAt": "2026-07-03T00:00:00Z",
            "detailsUrl": "https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/1/job/2",
            "checkSuite": {"commit": {"oid": HEAD}},
        })
    nodes.append({
        "__typename": "CheckRun",
        "name": "Rule: autoqueue admin-bypass PRs to master",
        "conclusion": "FAILURE",
        "status": "COMPLETED",
        "completedAt": "2026-07-03T00:00:00Z",
        "detailsUrl": "https://example.invalid/mergify",
        "checkSuite": {"commit": {"oid": HEAD}},
    })
    return {"contexts": {"nodes": nodes}}


def pr(number):
    labels = ["admin-bypass"]
    if number == 2605:
        labels.append("dequeued")
    threads = []
    if number == 2607:
        threads = [{
            "id": "thread-human",
            "isResolved": False,
            "comments": {"nodes": [{"author": {"login": "alice"}, "body": "please fix", "url": "https://example.invalid/thread"}]},
        }]
    return {
        "number": number,
        "title": f"PR {number}",
        "url": f"https://github.com/Neko-Catpital-Labs/Invoker/pull/{number}",
        "isDraft": False,
        "state": "OPEN",
        "baseRefName": "master",
        "headRefName": f"stack/{number}",
        "headRefOid": HEAD,
        "mergeStateStatus": "CLEAN",
        "mergeable": "MERGEABLE",
        "labels": {"nodes": [{"name": label} for label in labels]},
        "reviewThreads": {"pageInfo": {"hasNextPage": False}, "nodes": threads},
        "statusCheckRollup": contexts(number),
    }

args = sys.argv[1:]
if args[:2] == ["pr", "list"]:
    print(json.dumps([pr(2605), pr(2606), pr(2607)]))
    raise SystemExit(0)
if args[:2] == ["api", "graphql"]:
    number = 0
    for arg in args:
        if arg.startswith("number="):
            number = int(arg.split("=", 1)[1])
    print(json.dumps({"data": {"repository": {"pullRequest": pr(number)}}}))
    raise SystemExit(0)
if args[:2] == ["api", "repos/Neko-Catpital-Labs/Invoker/issues/2605/comments"]:
    body = """Left the queue `admin-bypass` at `c2532d229dbed2fd57419698c48d973001c78e9e`.
-*- Mergify Payload -*-
{"state":"dequeued","queue_rule_name":"admin-bypass"}
"""
    print(json.dumps([{"id": "m2605", "user": {"login": "mergify[bot]"}, "updated_at": "2026-07-03T00:00:00Z", "html_url": "https://example.invalid/m2605", "body": body}]))
    raise SystemExit(0)
if args[:2] == ["api", "repos/Neko-Catpital-Labs/Invoker/issues/2606/comments"] or args[:2] == ["api", "repos/Neko-Catpital-Labs/Invoker/issues/2607/comments"]:
    print("[]")
    raise SystemExit(0)
print(f"unexpected gh args: {args}", file=sys.stderr)
raise SystemExit(2)
PY
chmod +x "$TMP/bin/gh"

export PATH="$TMP/bin:$PATH"
out="$(python3 scripts/mergify_admin_requeue.py --dry-run --once --repo Neko-Catpital-Labs/Invoker --author EdbertChan --state-file "$TMP/ledger.jsonl")"
printf '%s\n' "$out"

case "$out" in
  *"DRY-RUN requeue PR #2605 head=c2532d229dbed2fd57419698c48d973001c78e9e reason=eligible-after-dequeue"*) ;;
  *) echo "[repro] missing requeue line" >&2; exit 1 ;;
esac
case "$out" in
  *"DRY-RUN repair-check PR #2606 check=\"PR Body\""*) ;;
  *) echo "[repro] missing repair line" >&2; exit 1 ;;
esac
case "$out" in
  *"BLOCK PR #2607 human-review-thread"*) ;;
  *) echo "[repro] missing human block line" >&2; exit 1 ;;
esac

echo "[repro] passed"
