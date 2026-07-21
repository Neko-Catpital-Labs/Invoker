#!/usr/bin/env bash
set -euo pipefail

# CodeRabbit PR #5483: load_candidate_stacks fetched full pr_detail (GraphQL) and
# issue_comments for EVERY open PR in the repo each cycle -- even PRs unrelated to
# any candidate's stack -- because the lightweight `gh pr list` JSON omits
# reviewThreads. This is O(open-PR-count) API calls per poll and risks GitHub
# rate-limit exhaustion.
# Buggy behaviour: an unrelated open PR (#999) triggers pr_detail + issue_comments.
# Fixed behaviour: only PRs linked to a candidate stack get the heavy fetches.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-pr5483-fetch.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
FETCH_LOG="$TMP/fetched.log"
export REPRO_FETCH_LOG="$FETCH_LOG"
: > "$FETCH_LOG"

cat > "$TMP/bin/gh" <<'PY'
#!/usr/bin/env python3
import json
import os
import sys

REPO = "Neko-Catpital-Labs/Invoker"
LOG = os.environ["REPRO_FETCH_LOG"]

# Candidate #1 (admin-bypass, master bottom) with upper #2 stacked on it; #999
# is an unrelated open PR that must NOT be individually fetched.
STACK = {
    1: {"base": "master", "head": "stack/one", "labels": ["admin-bypass"]},
    2: {"base": "stack/one", "head": "stack/two", "labels": []},
    999: {"base": "master", "head": "feature/unrelated", "labels": []},
}


def list_item(number):
    info = STACK[number]
    return {
        "number": number,
        "title": f"PR {number}",
        "url": f"https://example.invalid/{number}",
        "state": "OPEN",
        "isDraft": False,
        "baseRefName": info["base"],
        "headRefName": info["head"],
        "headRefOid": "b" * 40,
        "mergeStateStatus": "CLEAN",
        "mergeable": "MERGEABLE",
        "labels": {"nodes": [{"name": n} for n in info["labels"]]},
        # NOTE: `gh pr list` deliberately omits reviewThreads (matches real selector).
        "statusCheckRollup": {"contexts": {"nodes": []}},
    }


def detail(number):
    d = list_item(number)
    d["reviewThreads"] = {"pageInfo": {"hasNextPage": False}, "nodes": []}
    return d


def log(entry):
    with open(LOG, "a", encoding="utf-8") as fh:
        fh.write(entry + "\n")


args = sys.argv[1:]

if args[:2] == ["pr", "list"]:
    if "--label" in args and "admin-bypass" in args:
        print(json.dumps([list_item(1)]))  # candidates
    else:
        print(json.dumps([list_item(1), list_item(2), list_item(999)]))  # all open
    raise SystemExit(0)

if args[:2] == ["api", "graphql"]:
    number = 0
    for arg in args:
        if arg.startswith("number="):
            number = int(arg.split("=", 1)[1])
    log(f"detail {number}")
    print(json.dumps({"data": {"repository": {"pullRequest": detail(number)}}}))
    raise SystemExit(0)

if len(args) >= 2 and args[0] == "api" and args[1].startswith(f"repos/{REPO}/issues/") and args[1].endswith("/comments"):
    number = int(args[1].split("/issues/", 1)[1].split("/", 1)[0])
    log(f"comments {number}")
    print("[]")
    raise SystemExit(0)

print(f"unexpected gh args: {args}", file=sys.stderr)
raise SystemExit(2)
PY
chmod +x "$TMP/bin/gh"

PATH="$TMP/bin:$PATH" python3 scripts/mergify_admin_requeue.py --dry-run --once \
    --repo "Neko-Catpital-Labs/Invoker" --state-file "$TMP/ledger.jsonl" >/dev/null

if grep -q "999" "$FETCH_LOG"; then
    echo "FAIL: fetched full detail/comments for unrelated PR #999:"
    grep "999" "$FETCH_LOG"
    exit 1
fi

echo "PASS: heavy fetches skipped for open PRs outside any candidate stack"
