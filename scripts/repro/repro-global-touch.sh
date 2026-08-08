#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-global-touch.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "[repro] FAIL: $1" >&2
  exit 1
}

find_esbuild() {
  if [ -n "${INVOKER_ESBUILD:-}" ]; then
    [ -x "$INVOKER_ESBUILD" ] || fail "INVOKER_ESBUILD is not executable: $INVOKER_ESBUILD"
    printf '%s\n' "$INVOKER_ESBUILD"
    return
  fi

  shopt -s nullglob
  local candidates=("$ROOT"/node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild)
  shopt -u nullglob
  [ "${#candidates[@]}" -gt 0 ] || fail "vendored esbuild not found under node_modules/.pnpm"
  printf '%s\n' "${candidates[${#candidates[@]}-1]}"
}

ESBUILD="$(find_esbuild)"
DRIVER_TS="$TMP/repro-global-touch.ts"
DRIVER_JS="$TMP/repro-global-touch.cjs"

cat > "$DRIVER_TS" <<'TS'
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator, type OrchestratorMessageBus, type TaskState } from '@invoker/workflow-core';
import type { WorkResponse } from '@invoker/contracts';
import { SQLiteAdapter } from '@invoker/data-store';

const originalLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
  const line = args.map((arg) => String(arg)).join(' ');
  if (line.startsWith('[state-machine]') || line.startsWith('[merge-gate-workspace]')) return;
  originalLog(...args);
};

process.env.NODE_ENV = 'test';
process.env.INVOKER_TEST_WORKFLOW_IDS = '1';
process.env.INVOKER_TEST_FIXED_NOW = '2024-01-01T00:00:00.000Z';

class NoopBus implements OrchestratorMessageBus {
  publish<T>(_channel: string, _message: T): void {}
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function onlyNonMergeTask(tasks: TaskState[]): TaskState {
  const task = tasks.find((candidate) => !candidate.config.isMergeNode);
  assert(task, 'expected a non-merge task');
  return task;
}

function timestamps(adapter: SQLiteAdapter): Map<string, string> {
  return new Map(adapter.listWorkflows().map((workflow) => [workflow.id, workflow.updatedAt]));
}

async function main(): Promise<void> {
  const tempDbDir = mkdtempSync(join(tmpdir(), 'repro-global-touch-db-'));
  const adapter = await SQLiteAdapter.create(join(tempDbDir, 'invoker.db'), { ownerCapability: true });

  try {
    const orchestrator = new Orchestrator({
      persistence: adapter,
      messageBus: new NoopBus(),
      maxConcurrency: 128,
    });

    orchestrator.loadPlan({
      name: 'driver',
      tasks: [{ id: 'driver-task', description: 'the task whose terminal transition drives the sweep' }],
    });

    for (let index = 1; index <= 92; index += 1) {
      orchestrator.loadPlan({
        name: `old-failure-${index}`,
        tasks: [{ id: `failed-task-${index}`, description: 'old failed task' }],
      });
    }

    const workflows = adapter.listWorkflows();
    const driverWorkflow = workflows.find((workflow) => workflow.name === 'driver');
    assert(driverWorkflow, 'driver workflow was not persisted');
    const bystanderWorkflows = workflows.filter((workflow) => workflow.name.startsWith('old-failure-'));
    assert(bystanderWorkflows.length === 92, `expected 92 bystander workflows, saw ${bystanderWorkflows.length}`);

    adapter.updateWorkflow(driverWorkflow.id, { updatedAt: '2023-12-31T23:59:59.000Z' });
    for (let index = 0; index < bystanderWorkflows.length; index += 1) {
      const workflow = bystanderWorkflows[index]!;
      const task = onlyNonMergeTask(adapter.loadTasks(workflow.id));
      adapter.updateTask(task.id, {
        status: 'failed',
        execution: {
          completedAt: new Date('2024-01-02T00:00:00.000Z'),
          exitCode: 1,
          error: 'old failure that must not be resurfaced by an unrelated workflow transition',
        },
      });
      adapter.updateWorkflow(workflow.id, {
        updatedAt: `2024-01-03T00:${String(index).padStart(2, '0')}:00.000Z`,
      });
    }

    orchestrator.syncAllFromDb();
    orchestrator.startExecution();

    const driverTask = onlyNonMergeTask(adapter.loadTasks(driverWorkflow.id));
    assert(driverTask.status === 'running', `expected driver task to be running, got ${driverTask.status}`);

    const before = timestamps(adapter);
    const response: WorkResponse = {
      requestId: 'req-driver-complete',
      actionId: driverTask.id,
      attemptId: driverTask.execution.selectedAttemptId,
      executionGeneration: driverTask.execution.generation ?? 0,
      status: 'completed',
      outputs: { exitCode: 0 },
    };

    orchestrator.handleWorkerResponse(response);

    const after = timestamps(adapter);
    const driverBefore = before.get(driverWorkflow.id);
    const driverAfter = after.get(driverWorkflow.id);
    assert(driverBefore !== driverAfter, 'driver workflow was not touched, so the terminal transition path was not exercised');

    const changedBystanders = bystanderWorkflows
      .map((workflow) => ({
        id: workflow.id,
        name: workflow.name,
        before: before.get(workflow.id),
        after: after.get(workflow.id),
      }))
      .filter((row) => row.before !== row.after);

    if (changedBystanders.length > 0) {
      for (const row of changedBystanders.slice(0, 10)) {
        console.error(`[repro] changed ${row.name} (${row.id}): ${row.before} -> ${row.after}`);
      }
      throw new Error(
        `terminal transition rewrote updated_at on ${changedBystanders.length} unrelated workflow row(s)`,
      );
    }

    console.log("[repro] PASS: other workflows' updated_at stayed byte-for-byte unchanged after driver terminal transition");
  } finally {
    adapter.close();
    rmSync(tempDbDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[repro] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
TS

"$ESBUILD" "$DRIVER_TS" \
  --bundle \
  --platform=node \
  --format=cjs \
  --outfile="$DRIVER_JS" \
  --alias:@invoker/contracts="$ROOT/packages/contracts/src/index.ts" \
  --alias:@invoker/data-store="$ROOT/packages/data-store/src/index.ts" \
  --alias:@invoker/workflow-core="$ROOT/packages/workflow-core/src/index.ts" \
  --alias:@invoker/workflow-graph="$ROOT/packages/workflow-graph/src/index.ts" \
  --log-level=warning \
  >/dev/null

node "$DRIVER_JS"
