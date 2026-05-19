#!/usr/bin/env bash
# Proves the true root cause of the 14:17 11-task stall wave:
# `recreateWorkflow` / `recreateTask` preserve `config.poolMemberId`,
# so a rebase-recreate storm replays each task's prior pin without
# rebalancing. Audit-log evidence: all 11 stalled tasks recorded
#   task.executor.selected reason={"type":"explicitPoolMemberId"}
# at 14:14:39-14:14:47, with poolMemberId="remote_digital_ocean_1".
#
# Two checks:
#   1. Static — recreateTask/recreateWorkflow reset blocks clear
#      `summary` but not `poolMemberId`.
#   2. Runtime — vitest that runs Orchestrator.recreateWorkflow against
#      11 pinned tasks and asserts the pins survive.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

echo "== 1. Static check: recreate reset blocks =="
python3 - <<'PY'
import re, sys, pathlib
src = pathlib.Path('packages/workflow-core/src/orchestrator.ts').read_text()
findings = []
for fn in ('recreateTask(taskId:', 'recreateWorkflow(workflowId:'):
    i = src.index(fn)
    blk = src[i:i+2000]
    # Capture the resetChanges config:{...} block.
    cfg = re.search(r"config:\s*\{[^}]*\}", blk)
    if not cfg:
        findings.append(f'{fn}: could not locate config:{{...}} reset')
        continue
    text = cfg.group(0)
    clears_summary = 'summary' in text
    clears_pool   = 'poolMemberId' in text
    print(f'  {fn}')
    print(f'    config reset literal     : {text}')
    print(f'    clears summary?          : {clears_summary}')
    print(f'    clears poolMemberId?     : {clears_pool}')
    if not clears_summary:
        findings.append(f'{fn}: does NOT clear summary (test premise wrong)')
    if clears_pool:
        findings.append(f'{fn}: clears poolMemberId — root-cause hypothesis would be INVALIDATED')
if findings:
    for f in findings: print('  ! ' + f, file=sys.stderr)
    sys.exit(1)
print('  ✓ static check confirms: recreate paths leave poolMemberId untouched')
PY

echo
echo "== 2. Runtime check: vitest in packages/workflow-core =="
cd packages/workflow-core
pnpm test -- src/__tests__/repro-recreate-preserves-pool-pin.test.ts 2>&1 | tail -40

echo
echo "PROVED:"
echo "  rebase-recreate preserves config.poolMemberId across generations."
echo "  The 14:17 stall wave is NOT a leastLoaded scheduler race — it is a"
echo "  deterministic replay of every task's last pinned host."
