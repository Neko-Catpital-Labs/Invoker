#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-mergify-closed-pr-guard.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

cat > "$TMP/bin/gh" <<'PY'
#!/usr/bin/env python3
import json
import sys
from pathlib import Path

sys.path.insert(0, "scripts")
from mergify_admin_requeue_model import load_mergify_rules

HEAD = "1111111111111111111111111111111111111111"
# Loaded from .mergify.yml, not hardcoded: a hardcoded copy silently drifts
# out of sync whenever the real required-check set changes.
_, _, _REQUIRED_FROM_MERGIFY_YML = load_mergify_rules(Path(".mergify.yml"))
REQUIRED = sorted(_REQUIRED_FROM_MERGIFY_YML | {
    "required-fast / Vitest Workspace",
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
})


def pr():
    nodes = [{
        "__typename": "CheckRun",
        "name": name,
        "conclusion": "SUCCESS",
        "status": "COMPLETED",
        "completedAt": "2026-07-03T00:00:00Z",
        "detailsUrl": "https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/1/job/2",
        "checkSuite": {"commit": {"oid": HEAD}},
    } for name in REQUIRED]
    return {
        "number": 2999,
        "title": "Closed admin bypass PR",
        "url": "https://github.com/Neko-Catpital-Labs/Invoker/pull/2999",
        "isDraft": False,
        "state": "CLOSED",
        "baseRefName": "master",
        "headRefName": "closed/admin-bypass",
        "headRefOid": HEAD,
        "mergeStateStatus": "CLEAN",
        "mergeable": "MERGEABLE",
        "labels": {"nodes": [{"name": "admin-bypass"}, {"name": "dequeued"}]},
        "reviewThreads": {"pageInfo": {"hasNextPage": False}, "nodes": []},
        "statusCheckRollup": {"contexts": {"nodes": nodes}},
    }

args = sys.argv[1:]
if args[:2] == ["pr", "list"] and "--label" not in args:
    print("[]")
    raise SystemExit(0)
if args[:2] == ["api", "graphql"]:
    print(json.dumps({"data": {"repository": {"pullRequest": pr()}}}))
    raise SystemExit(0)
if args[:2] == ["api", "repos/Neko-Catpital-Labs/Invoker/issues/2999/comments"]:
    print(json.dumps([{"id": "m2999", "user": {"login": "mergify"}, "updated_at": "2026-07-03T00:00:00Z", "body": "-*- Mergify Payload -*-\n{\"state\":\"dequeued\",\"queue_rule_name\":\"admin-bypass\"}\nLeft the queue at `1111111111111111111111111111111111111111`"}]))
    raise SystemExit(0)
print(f"unexpected gh args: {args}", file=sys.stderr)
raise SystemExit(2)
PY
chmod +x "$TMP/bin/gh"

export PATH="$TMP/bin:$PATH"
out="$(python3 scripts/mergify_admin_requeue.py --dry-run --once --repo Neko-Catpital-Labs/Invoker --author EdbertChan --state-file "$TMP/ledger.jsonl" --pr 2999)"
printf '%s\n' "$out"

case "$out" in
  *"BLOCK PR #2999 state=CLOSED"*) ;;
  *) echo "[repro] missing closed block line" >&2; exit 1 ;;
esac
case "$out" in
  *"DRY-RUN requeue PR #2999"*) echo "[repro] wrongly requeued closed PR" >&2; exit 1 ;;
esac

echo "[repro] passed"
