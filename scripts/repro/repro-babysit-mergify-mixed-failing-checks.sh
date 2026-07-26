#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-mergify-mixed-failing-checks.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

cat > "$TMP/bin/gh" <<'PY'
#!/usr/bin/env python3
import json
import sys

HEAD = "26ca69a18415aaf69ff0b14f52e15d1462b95994"


def check(name, conclusion, job):
    return {
        "__typename": "CheckRun",
        "name": name,
        "conclusion": conclusion,
        "status": "COMPLETED",
        "completedAt": "2026-07-26T08:25:00Z",
        "detailsUrl": f"https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/30194560781/job/{job}",
        "checkSuite": {"commit": {"oid": HEAD}},
    }


def pr():
    nodes = [
        check("build-artifacts", "SKIPPED", "89773637805"),
        check("PR Body", "SUCCESS", "89773637397"),
        check("quality / Dependency Cruise", "SUCCESS", "89773637383"),
        check("quality / TypeScript Types", "FAILURE", "89773637394"),
        check("UI Vitest", "SUCCESS", "89773637368"),
        check("required-fast / Reset Rulebook Repro", "SKIPPED", "89773637845"),
    ]
    return {
        "number": 5873,
        "title": "Route owner-serve through web surface startup",
        "body": "## Summary\n\nOwner serve repro.\n",
        "url": "https://github.com/Neko-Catpital-Labs/Invoker/pull/5873",
        "isDraft": False,
        "state": "OPEN",
        "baseRefName": "master",
        "headRefName": "pr/owner-serve-web-surface",
        "headRefOid": HEAD,
        "mergeStateStatus": "BLOCKED",
        "mergeable": "MERGEABLE",
        "labels": {"nodes": [{"name": "admin-bypass"}, {"name": "dequeued"}]},
        "reviewThreads": {
            "pageInfo": {"hasNextPage": False},
            "nodes": [
                {
                    "id": "PRRT_kwDOSFkSDM6T1ahS",
                    "isResolved": False,
                    "comments": {"nodes": [{"author": {"login": "coderabbitai"}}]},
                }
            ],
        },
        "statusCheckRollup": {"contexts": {"nodes": nodes}},
    }


args = sys.argv[1:]
if args[:2] == ["pr", "list"]:
    print("[]")
    raise SystemExit(0)
if args[:2] == ["api", "graphql"]:
    print(json.dumps({"data": {"repository": {"pullRequest": pr()}}}))
    raise SystemExit(0)
if args[:2] == ["api", "repos/Neko-Catpital-Labs/Invoker/issues/5873/comments"]:
    body = f"""<!---
DO NOT EDIT
-*- Mergify Payload -*-
{{"version": 1, "state": "dequeued", "queue_rule_name": "admin-bypass", "queued_at": "2026-07-26T08:25:26.362025+00:00", "required_conditions": []}}
-*- Mergify Payload End -*-
-->

# Merge Queue Status

- ✅ **Entered queue** — `2026-07-26 08:25 UTC` · Rule: `admin-bypass`
- ❌ **Checks failed** · on draft #5874
- 🚫 **Left the queue** — `2026-07-26 08:26 UTC` · at `{HEAD}`

<details>
<summary><strong>Waiting for</strong></summary>

- [ ] `check-success = PR Body`
- [ ] `check-success = UI Vitest`
- [ ] `check-success = build-artifacts`
- [ ] `check-success = quality / TypeScript Types`
- [ ] `check-success = required-fast / Guardrails`
- [ ] `check-success = required-fast / Submit Workflow Chain`

</details>
<details>
<summary>All conditions</summary>

- [ ] `check-success = PR Body`
- [ ] `check-success = UI Vitest`
- [ ] `check-success = build-artifacts`
- [ ] `check-success = quality / TypeScript Types`
- [ ] `check-success = required-fast / Guardrails`
- [ ] `check-success = required-fast / Submit Workflow Chain`
- [X] `check-success = quality / Dependency Cruise`

</details>

## Reason

The merge conditions cannot be satisfied due to failing checks

- `quality / TypeScript Types`

Failing checks:
- 🟠 [build-artifacts](https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/30194603425/job/89773749306) ([job log](https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/30194603425/job/89773749306))
- 🟠 [PR Body](https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/30194631822/job/89773828741) ([job log](https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/30194631822/job/89773828741))
- ❌ [quality / TypeScript Types](https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/30194603425/job/89773749260) ([job log](https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/30194603425/job/89773749260))
- 🟠 [UI Vitest](https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/30194603425/job/89773749271) ([job log](https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/30194603425/job/89773749271))
"""
    print(json.dumps([{
        "id": "m5873",
        "user": {"login": "mergify"},
        "updated_at": "2026-07-26T08:26:52Z",
        "html_url": "https://github.com/Neko-Catpital-Labs/Invoker/pull/5873#issuecomment-5082710895",
        "body": body,
    }]))
    raise SystemExit(0)
print(f"unexpected gh args: {args}", file=sys.stderr)
raise SystemExit(2)
PY
chmod +x "$TMP/bin/gh"

export PATH="$TMP/bin:$PATH"
out="$(python3 scripts/mergify_admin_requeue.py --dry-run --once --repo Neko-Catpital-Labs/Invoker --state-file "$TMP/ledger.jsonl" --pr 5873)"
printf '%s\n' "$out"

case "$out" in
  *"DRY-RUN repair-check PR #5873 check=\"quality / TypeScript Types\""*) ;;
  *) echo "[repro] missing TypeScript repair line" >&2; exit 1 ;;
esac
case "$out" in
  *"DRY-RUN repair-check PR #5873 check=\"build-artifacts\""*) echo "[repro] wrongly repaired an orange queue row first" >&2; exit 1 ;;
esac

echo "[repro] passed"
