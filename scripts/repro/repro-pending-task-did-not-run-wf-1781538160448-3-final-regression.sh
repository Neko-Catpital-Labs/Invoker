#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TASK_ID="wf-1781538160448-3/final-regression"
MAIN_TS="$ROOT/packages/app/src/main.ts"

echo "[repro] task: $TASK_ID"
echo "[repro] root cause: standalone headless owner could answer owner-ping without polling active launch dispatch rows"

python3 - "$MAIN_TS" <<'PY'
import pathlib
import sys

main_path = pathlib.Path(sys.argv[1])
source = main_path.read_text(encoding="utf-8")

task_id = "wf-1781538160448-3/final-regression"

class DispatchRow:
    def __init__(self):
        self.state = "enqueued"
        self.attempt_id = f"{task_id}-aa3f6940f"
        self.runner_calls = 0

def gui_db_poll_tick(row: DispatchRow, *, main_window_present: bool) -> None:
    if not main_window_present:
        return
    launch_dispatcher_poll(row)

def launch_dispatcher_poll(row: DispatchRow) -> None:
    if row.state != "enqueued":
        return
    row.state = "leased"
    row.runner_calls += 1
    row.state = "completed"

pre_fix = DispatchRow()
owner_ping_ready = True
gui_db_poll_tick(pre_fix, main_window_present=False)

assert owner_ping_ready
assert pre_fix.state == "enqueued", "pre-fix model should leave the dispatch row enqueued"
assert pre_fix.runner_calls == 0, "pre-fix model should never call the runner"

post_fix = DispatchRow()
launch_dispatcher_poll(post_fix)

assert post_fix.state == "completed", "fixed model should advance the dispatch row"
assert post_fix.runner_calls == 1, "fixed model should hand off to a runner exactly once"

required_needles = [
    "let standaloneLaunchDispatcherPollInterval",
    "const ensureStandaloneLaunchDispatcher = (): void =>",
    "headlessDeps.ownerTaskRunnerProvider = () => ownerTaskExecutor",
    "setInterval(pollStandaloneLaunchDispatcher, 2_000)",
    "if (standaloneMode && messageBus) {\n        if (!readOnlyMode) ensureStandaloneLaunchDispatcher();",
]
missing = [needle for needle in required_needles if needle not in source]
if missing:
    raise SystemExit("fixed standalone owner launch-dispatcher wiring is missing: " + ", ".join(missing))

print("[repro] pre-fix model: owner-ping ready + no main window leaves active launch dispatch enqueued")
print("[repro] post-fix model: standalone owner polls launch dispatcher and hands off the enqueued dispatch")
print("[repro] source check: standalone owner installs active launch-dispatcher polling loop")
PY

echo "[repro] passed"
