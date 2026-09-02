import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import { SQLITE_MAX_VARIABLE_NUMBER } from '../sqlite-workflow-repository.js';

const WORKFLOW_COUNT_ABOVE_LIMIT = SQLITE_MAX_VARIABLE_NUMBER + 100;

function seedWorkflowReadFixture(adapter: SQLiteAdapter, includeTasks: boolean): void {
  const db = (adapter as unknown as { nativeDb: DatabaseSync }).nativeDb;
  const insertWorkflow = db.prepare(`
    INSERT INTO workflows (id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `);
  const insertTask = includeTasks
    ? db.prepare(`
        INSERT INTO tasks (id, workflow_id, description, status, dependencies, created_at)
        VALUES (?, ?, ?, 'pending', '[]', ?)
      `)
    : undefined;
  const now = new Date().toISOString();

  db.exec('BEGIN');
  try {
    for (let i = 0; i < WORKFLOW_COUNT_ABOVE_LIMIT; i++) {
      const workflowId = `wf-${i}`;
      insertWorkflow.run(workflowId, `Workflow ${i}`, now, now);
      insertTask?.run(`${workflowId}/t0`, workflowId, `Task ${i}`, now);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

describe('SQL variables limit (ui-read-scale)', () => {
  let tmpDir: string;
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sql-vars-repro-'));
    adapter = await SQLiteAdapter.create(join(tmpDir, 'invoker.db'), { ownerCapability: true });
  });

  afterEach(async () => {
    await adapter.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it(
    'loadWorkflowTaskSnapshot handles >32k workflows via chunked queries',
    async () => {
      seedWorkflowReadFixture(adapter, true);

      const snapshot = adapter.loadWorkflowTaskSnapshot();
      expect(snapshot.workflows).toHaveLength(WORKFLOW_COUNT_ABOVE_LIMIT);
      expect(snapshot.tasks).toHaveLength(WORKFLOW_COUNT_ABOVE_LIMIT);
    },
    60_000,
  );

  it('listWorkflows handles >32k workflows via chunked rollup queries', async () => {
    seedWorkflowReadFixture(adapter, false);

    const workflows = adapter.listWorkflows();
    expect(workflows).toHaveLength(WORKFLOW_COUNT_ABOVE_LIMIT);
  });

  it('loadTasksForWorkflows handles >32k workflow IDs via chunked queries', async () => {
    const workflowIds = Array.from({ length: WORKFLOW_COUNT_ABOVE_LIMIT }, (_, i) => `wf-${i}`);
    const tasks = adapter.loadTasksForWorkflows(workflowIds);
    expect(tasks).toHaveLength(0);
  });
});
