#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');
const distPath = join(root, 'packages/data-store/dist/index.js');
const { SQLiteAdapter } = await import(pathToFileURL(distPath).href);

const tempDir = mkdtempSync(join(tmpdir(), 'invoker-launch-dispatch-repro-'));
const dbPath = join(tempDir, 'invoker.db');
const workflowId = 'wf-launch-dispatch-repro';
const nowIso = '2026-06-04T00:00:00.000Z';
const expiredIso = '2026-06-03T23:59:00.000Z';
const targetTaskId = `${workflowId}/target`;
const targetAttemptId = `${targetTaskId}-attempt`;

let adapter;

function fail(message) {
  throw new Error(`[launch-dispatch-repro] ${message}`);
}

function makeTask(id, attemptId, status = 'pending', generation = 0) {
  return {
    id,
    description: id,
    status,
    dependencies: [],
    createdAt: new Date(nowIso),
    config: { workflowId },
    execution: { selectedAttemptId: attemptId, generation, phase: 'launching' },
    taskStateVersion: 1,
  };
}

function saveTask(id, attemptId, status = 'pending', generation = 0) {
  adapter.saveTask(workflowId, makeTask(id, attemptId, status, generation));
  adapter.updateTask(id, {
    status,
    execution: { selectedAttemptId: attemptId, generation, phase: 'launching' },
  });
}

function scalar(sql) {
  const result = adapter.db.exec(sql);
  return Number(result[0]?.values?.[0]?.[0] ?? 0);
}

try {
  adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
  adapter.saveWorkflow({
    id: workflowId,
    name: 'launch dispatch queue handoff repro',
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  for (let i = 0; i < 12; i += 1) {
    const taskId = `${workflowId}/legacy-${i}`;
    const currentAttemptId = `${taskId}-current`;
    const staleAttemptId = `${taskId}-stale`;
    saveTask(taskId, currentAttemptId, 'pending', 1);
    const row = adapter.enqueueLaunchDispatch({
      taskId,
      attemptId: staleAttemptId,
      workflowId,
      generation: 0,
    });
    adapter.db.run(
      `UPDATE task_launch_dispatch
          SET state = 'acknowledged',
              dispatch_owner = 'old-owner',
              leased_at = ?,
              acknowledged_at = ?,
              fenced_until = ?,
              attempts_count = 1
        WHERE id = ?`,
      [expiredIso, expiredIso, expiredIso, row.id],
    );
  }

  saveTask(targetTaskId, targetAttemptId, 'pending', 0);
  const target = adapter.enqueueLaunchDispatch({
    taskId: targetTaskId,
    attemptId: targetAttemptId,
    workflowId,
    generation: 0,
  });

  const report = adapter.runCompatibilityMigration();
  const legacyAckCount = scalar(
    `SELECT COUNT(*) AS count FROM task_launch_dispatch WHERE state = 'acknowledged'`,
  );
  if (legacyAckCount !== 0) {
    fail(
      `compatibility migration left ${legacyAckCount} acknowledged row(s); ` +
        `report=${JSON.stringify(report)}`,
    );
  }

  const targetAfterMigration = adapter.loadLaunchDispatchById(target.id);
  if (targetAfterMigration?.state !== 'enqueued') {
    fail(`target dispatch should remain enqueued, got ${targetAfterMigration?.state ?? 'missing'}`);
  }

  const leased = adapter.claimLaunchDispatchAtomic({
    ownerId: 'repro-owner',
    nowIso,
  });
  if (!leased) {
    fail('claimLaunchDispatchAtomic returned undefined while target row was enqueued');
  }
  if (leased.id !== target.id) {
    fail(`expected to lease target dispatch ${target.id}, leased ${leased.id}`);
  }
  if (leased.state !== 'leased') {
    fail(`expected leased target state, got ${leased.state}`);
  }

  const abandonedLegacyCount = scalar(
    `SELECT COUNT(*) AS count FROM task_launch_dispatch WHERE state = 'abandoned'`,
  );
  if (abandonedLegacyCount !== 12) {
    fail(`expected 12 abandoned legacy rows, got ${abandonedLegacyCount}`);
  }

  console.log('[launch-dispatch-repro] passed');
} finally {
  adapter?.close();
  rmSync(tempDir, { recursive: true, force: true });
}
