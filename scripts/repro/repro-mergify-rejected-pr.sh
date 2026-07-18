#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-mergify-rejected-pr.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

cat > "$TMP/bin/gh" <<'PY'
#!/usr/bin/env python3
import json
import sys

HEAD = "79035e5e42f8eda9f22a68697c241eb459555081"
REQUIRED = [
    "build-artifacts",
    "quality / Dependency Cruise",
    "PR Body",
    "quality / TypeScript Types",
    "required-fast / Guardrails",
    "required-fast / Vitest Workspace",
    "required-fast / Submit Workflow Chain",
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
]


def pr():
    nodes = []
    for name in REQUIRED:
        nodes.append({
            "__typename": "CheckRun",
            "name": name,
            "conclusion": "SUCCESS",
            "status": "COMPLETED",
            "completedAt": "2026-07-03T06:10:00Z",
            "detailsUrl": "https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/1/job/2",
            "checkSuite": {"commit": {"oid": HEAD}},
        })
    return {
        "number": 2969,
        "title": "[Mergify Runner Isolation](1) Route queue jobs to dedicated runners",
        "url": "https://github.com/Neko-Catpital-Labs/Invoker/pull/2969",
        "isDraft": False,
        "state": "OPEN",
        "baseRefName": "master",
        "headRefName": "stack/EdbertChan/mergify-runner-isolation/isolate-mergify-queue-runners--cfb9a3aa",
        "headRefOid": HEAD,
        "mergeStateStatus": "BLOCKED",
        "mergeable": "MERGEABLE",
        "labels": {"nodes": [{"name": "admin-bypass"}, {"name": "dequeued"}]},
        "reviewThreads": {"pageInfo": {"hasNextPage": False}, "nodes": []},
        "statusCheckRollup": {"contexts": {"nodes": nodes}},
    }

args = sys.argv[1:]
if args[:2] == ["api", "graphql"]:
    print(json.dumps({"data": {"repository": {"pullRequest": pr()}}}))
    raise SystemExit(0)
if args[:2] == ["api", "repos/Neko-Catpital-Labs/Invoker/issues/2969/comments"]:
    body = """<!---
DO NOT EDIT
-*- Mergify Payload -*-
{"version":1,"state":"dequeued","queue_rule_name":"admin-bypass","queued_at":"2026-07-03T05:47:54.103584+00:00","required_conditions":[]}
-*- Mergify Payload End -*-
-->

# Merge Queue Status

- ❌ **Checks failed** · on draft #2985
- 🚫 **Left the queue** — `2026-07-03 06:13 UTC` · at `79035e5e42f8eda9f22a68697c241eb459555081`

<details>
<summary><strong>Waiting for</strong></summary>

- [ ] `check-success = e2e-proof / aggregate`

</details>
<details>
<summary>All conditions</summary>

- [ ] `check-success = e2e-proof / aggregate`
- [X] `check-success = PR Body`
- [X] `check-success = optional / Visual Proof Validate`

</details>

## Reason

The merge conditions cannot be satisfied due to failing checks

- `e2e-proof / aggregate`

Failing checks:
- 🛑 [PR Body](https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/28641642476/job/84938961337) ([job log](https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/28641642476/job/84938961337))
"""
    print(json.dumps([{"id": "m2969", "user": {"login": "mergify"}, "updated_at": "2026-07-03T06:14:00Z", "html_url": "https://github.com/Neko-Catpital-Labs/Invoker/pull/2969#issuecomment-4872966494", "body": body}]))
    raise SystemExit(0)
print(f"unexpected gh args: {args}", file=sys.stderr)
raise SystemExit(2)
PY
chmod +x "$TMP/bin/gh"

export PATH="$TMP/bin:$PATH"
out="$(python3 scripts/mergify_admin_requeue.py --dry-run --once --repo Neko-Catpital-Labs/Invoker --author EdbertChan --state-file "$TMP/ledger.jsonl" --pr 2969)"
printf '%s\n' "$out"

case "$out" in
  *"DRY-RUN repair-check PR #2969 check=\"PR Body\""*) ;;
  *) echo "[repro] missing Mergify rejection repair line" >&2; exit 1 ;;
esac
case "$out" in
  *"BLOCK PR #2969 missing-check"*) echo "[repro] wrongly blocked on missing current check" >&2; exit 1 ;;
esac
case "$out" in
  *"DRY-RUN requeue PR #2969"*) echo "[repro] wrongly requeued before repair" >&2; exit 1 ;;
esac

echo "[repro] passed"
