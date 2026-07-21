#!/usr/bin/env bash
set -euo pipefail

# CodeRabbit PR #5483: the "ready" requeue key never escalated. Once one requeue
# attempt was recorded, plan_stack_actions returned () permanently -- no cap, no
# operator-visible notification -- so a stack that Mergify never actually queues
# stalls forever silently, unlike every other blocker which escalates via
# cap_action/comment_blocked.
# Buggy behaviour: exhausted "ready" attempts return () (silent stall).
# Fixed behaviour: exhausted "ready" attempts escalate to comment_blocked/capped.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

python3 - <<'PY'
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path("scripts").resolve()))
import mergify_admin_requeue_model as m
import mergify_admin_requeue_plan as p

HEAD = "a" * 40


def ready_bottom():
    return m.PrSnapshot(
        number=1, title="", url="", state="OPEN", is_draft=False,
        base_ref_name="master", head_ref_name="h", head_ref_oid=HEAD,
        merge_state_status="CLEAN", mergeable="MERGEABLE",
        labels=frozenset({"admin-bypass"}),
        checks={"build": m.CheckContext("build", "success", "", HEAD, "")},
        review_threads=(),
        latest_mergify=None,  # never queued by Mergify -> "ready" key
    )


d = tempfile.mkdtemp()
led = m.Ledger(Path(d) / "ledger.jsonl")
# Exhaust the requeue budget on the "ready" key at its current head.
for _ in range(2):
    led.record("requeue", 1, HEAD, "ready")

actions = p.plan_stack_actions(m.StackGroup("s", (ready_bottom(),)), {"build"}, led, 0)

if actions == ():
    print("FAIL: exhausted 'ready' requeues returned () -- silent stall, no operator signal")
    sys.exit(1)

if not (actions and actions[0].kind == "comment_blocked" and actions[0].key == "capped"):
    print(f"FAIL: 'ready' key did not escalate to a capped notification; got {[(a.kind, a.key) for a in actions]}")
    sys.exit(1)

print("PASS: exhausted 'ready' requeues escalate to a capped, operator-visible notification")
PY
