#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[repro] stale SSH pool capacity after retry preempt"

echo "[repro] asserting app preempt kill routes through TaskRunner first"
python3 - "$ROOT" <<'PY'
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
main = root / "packages" / "app" / "src" / "main.ts"
text = main.read_text(encoding="utf-8")
if "killRunningTaskExecution" not in text:
    raise SystemExit("main kill path does not use killRunningTaskExecution")
if "await entry.executor.kill(entry.handle);" in text:
    raise SystemExit("main kill path still bypasses TaskRunner active execution cleanup")
wiring = root / "packages" / "app" / "src" / "execution" / "task-runner-wiring.ts"
wiring_text = wiring.read_text(encoding="utf-8")
if re.search(r"const entry = deps\\.taskHandles\\.get\\(taskId\\);\\s*if \\(!entry\\) return;", wiring_text):
    raise SystemExit("app kill path still skips TaskRunner when taskHandles missed the task")
runner = root / "packages" / "execution-engine" / "src" / "task-runner.ts"
runner_text = runner.read_text(encoding="utf-8")
if "async killActiveExecution(taskId: string): Promise<boolean>" not in runner_text:
    raise SystemExit("TaskRunner.killActiveExecution does not report whether it cleaned an active entry")
if re.search(r"if \\(selectedAttemptId\\).*?return undefined;", runner_text, re.S):
    raise SystemExit("TaskRunner active lookup still stops at stale selectedAttemptId")
PY

echo "[repro] running app preempt-kill wiring regression"
pnpm --filter @invoker/app exec vitest run src/__tests__/task-runner-wiring.test.ts

echo "[repro] running SSH pool capacity regression"
pnpm --filter @invoker/execution-engine exec vitest run src/__tests__/ssh-pool-member-capacity.test.ts

echo "[repro] passed"
