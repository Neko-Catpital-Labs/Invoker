#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[repro] launch outbox active-only cleanup"

echo "[repro] checking the rollout flag and mode plumbing are gone"
python3 - "$ROOT" <<'PY'
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
needles = [
    "INVOKER_" + "LAUNCH_OUTBOX",
    "launch" + "OutboxMode",
    "resolve" + "Launch" + "Outbox" + "Mode",
    "Launch" + "Outbox" + "Mode",
]
paths = [
    root / "packages" / "app" / "src",
    root / "packages" / "workflow-core" / "src",
    root / "packages" / "cli" / "src",
    root / "scripts" / "repro",
    root / "docs" / "incidents" / "2026-05-22-launch-handoff-architecture-proposal.md",
]
self_name = "repro-launch-outbox-active-only.sh"
matches = []
for base in paths:
    files = [base] if base.is_file() else base.rglob("*")
    for path in files:
        if not path.is_file() or path.name == self_name:
            continue
        if path.suffix not in {".ts", ".tsx", ".sh", ".md"}:
            continue
        text = path.read_text(encoding="utf-8")
        for needle in needles:
            if needle in text:
                matches.append(f"{path.relative_to(root)}: {needle}")
if matches:
    raise SystemExit("removed launch-outbox flag still referenced:\n" + "\n".join(matches))
PY

echo "[repro] running active-only launch tests"
pnpm --filter @invoker/app exec vitest run \
  src/__tests__/config.test.ts \
  src/__tests__/global-topup.test.ts \
  src/__tests__/headless-create-executor.test.ts \
  src/__tests__/launch-dispatcher.test.ts \
  src/__tests__/launch-claim-orphan-regression.test.ts \
  src/__tests__/launch-pool-deferral-outbox-repro.test.ts
pnpm --filter @invoker/workflow-core exec vitest run src/__tests__/orchestrator-dispatcher.test.ts

echo "[repro] passed"
