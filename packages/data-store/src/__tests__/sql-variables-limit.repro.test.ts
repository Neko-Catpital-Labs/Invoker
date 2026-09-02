import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import { SQLITE_MAX_VARIABLE_NUMBER } from '../sqlite-workflow-repository.js';

const WORKFLOW_COUNT_ABOVE_LIMIT = SQLITE_MAX_VARIABLE_NUMBER + 100;

function seedWorkflows(adapter: SQLiteAdapter, options: { withTasks?: boolean } = {}): void {
  const createdAt = new Date();
  adapter.runInTransaction(() => {
    for (let i = 0; i < WORKFLOW_COUNT_ABOVE_LIMIT; i++) {
      adapter.saveWorkflow({
        id: `wf-${i}`,
        name: `Workflow ${i}`,
        status: 'pending',
        createdAt: createdAt.toISOString(),
        updatedAt: createdAt.toISOString(),
      });
      if (options.withTasks) {
        adapter.saveTask(`wf-${i}`, {
          id: `wf-${i}/t0`,
          description: `Task ${i}`,
          status: 'pending',
          dependencies: [],
          createdAt,
          config: { workflowId: `wf-${i}` },
          execution: {},
          taskStateVersion: 1,
        });
      }
    }
  });
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
      seedWorkflows(adapter, { withTasks: true });

      const snapshot = adapter.loadWorkflowTaskSnapshot();
      expect(snapshot.workflows).toHaveLength(WORKFLOW_COUNT_ABOVE_LIMIT);
      expect(snapshot.tasks).toHaveLength(WORKFLOW_COUNT_ABOVE_LIMIT);
    },
    60_000,
  );

  it('listWorkflows handles >32k workflows via chunked rollup queries', async () => {
    seedWorkflows(adapter);

    const workflows = adapter.listWorkflows();
    expect(workflows).toHaveLength(WORKFLOW_COUNT_ABOVE_LIMIT);
  });

  it('loadTasksForWorkflows handles >32k workflow IDs via chunked queries', async () => {
    seedWorkflows(adapter);

    const workflowIds = Array.from({ length: WORKFLOW_COUNT_ABOVE_LIMIT }, (_, i) => `wf-${i}`);
    const tasks = adapter.loadTasksForWorkflows(workflowIds);
    expect(tasks).toHaveLength(0);
  });
});
