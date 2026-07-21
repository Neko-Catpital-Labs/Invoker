#!/usr/bin/env bash
set -euo pipefail

# CodeRabbit PR #5483: --max-requeue-attempts / --max-repair-attempts were
# parsed into args but never threaded into plan_stack_actions, which hardcoded
# its own thresholds (2 for requeue, 3 for repairs). The flags were dead config.
# Buggy behaviour: plan_stack_actions rejects the kwargs (TypeError) or ignores
# them; a tighter --max-requeue-attempts/--max-repair-attempts changes nothing.
# Fixed behaviour: the thresholds are honoured.

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


def bottom(**over):
    base = dict(
        number=1, title="", url="", state="OPEN", is_draft=False,
        base_ref_name="master", head_ref_name="h", head_ref_oid=HEAD,
        merge_state_status="CLEAN", mergeable="MERGEABLE",
        labels=frozenset({"admin-bypass"}),
        checks={"build": m.CheckContext("build", "success", "", HEAD, "")},
        review_threads=(),
        latest_mergify=m.MergifyQueueEvent("cm1", "dequeued", "", "", HEAD, (), (), ""),
    )
    base.update(over)
    return m.PrSnapshot(**base)


def ledger():
    d = tempfile.mkdtemp()
    return m.Ledger(Path(d) / "ledger.jsonl")


# --- max_requeue_attempts ---
led = ledger()
led.record("requeue", 1, HEAD, "cm1")  # one prior requeue on this dequeue event
stack = m.StackGroup("s", (bottom(),))
try:
    actions = p.plan_stack_actions(stack, {"build"}, led, 0, max_requeue_attempts=1, max_repair_attempts=3)
except TypeError as exc:
    print(f"FAIL: plan_stack_actions ignores max-attempts config (dead flags): {exc}")
    sys.exit(1)

if not (actions and actions[0].kind == "comment_blocked" and actions[0].key == "capped"):
    print(f"FAIL: max_requeue_attempts=1 not honoured; expected capped, got {[(a.kind, a.key) for a in actions]}")
    sys.exit(1)

# Sanity: with the default cap of 2, a single prior attempt still requeues.
led2 = ledger()
led2.record("requeue", 1, HEAD, "cm1")
actions_default = p.plan_stack_actions(m.StackGroup("s", (bottom(),)), {"build"}, led2, 0)
if not (actions_default and actions_default[0].kind == "requeue"):
    print(f"FAIL: default max_requeue_attempts regressed; got {[(a.kind, a.key) for a in actions_default]}")
    sys.exit(1)

# --- max_repair_attempts ---
led3 = ledger()
led3.record("repair-check", 1, HEAD, "build")  # one prior repair
conflict_pr = bottom(checks={"build": m.CheckContext("build", "failure", "", HEAD, "")})
actions_repair = p.plan_stack_actions(m.StackGroup("s", (conflict_pr,)), {"build"}, led3, 0, max_repair_attempts=1)
if not (actions_repair and actions_repair[0].kind == "comment_blocked" and actions_repair[0].key == "capped"):
    print(f"FAIL: max_repair_attempts=1 not honoured; expected capped, got {[(a.kind, a.key) for a in actions_repair]}")
    sys.exit(1)

print("PASS: --max-requeue-attempts and --max-repair-attempts are wired into plan_stack_actions")
PY
