import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import { SQLITE_MAX_VARIABLE_NUMBER } from '../sqlite-workflow-repository.js';

const WORKFLOW_COUNT_ABOVE_LIMIT = SQLITE_MAX_VARIABLE_NUMBER + 100;
const INSERT_BATCH_SIZE = 1000;

async function seedWorkflows(adapter: SQLiteAdapter, includeTasks = false): Promise<void> {
  for (let start = 0; start < WORKFLOW_COUNT_ABOVE_LIMIT; start += INSERT_BATCH_SIZE) {
    const end = Math.min(start + INSERT_BATCH_SIZE, WORKFLOW_COUNT_ABOVE_LIMIT);
    adapter.runInTransaction(() => {
      for (let i = start; i < end; i++) {
        adapter.saveWorkflow({
          id: `wf-${i}`,
          name: `Workflow ${i}`,
          status: 'pending',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        if (includeTasks) {
          adapter.saveTask(`wf-${i}`, {
            id: `wf-${i}/t0`,
            description: `Task ${i}`,
            status: 'pending',
            dependencies: [],
            createdAt: new Date(),
            config: { workflowId: `wf-${i}` },
            execution: {},
            taskStateVersion: 1,
          });
        }
      }
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
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
      await seedWorkflows(adapter, true);

      const snapshot = adapter.loadWorkflowTaskSnapshot();
      expect(snapshot.workflows).toHaveLength(WORKFLOW_COUNT_ABOVE_LIMIT);
      expect(snapshot.tasks).toHaveLength(WORKFLOW_COUNT_ABOVE_LIMIT);
    },
    60_000,
  );

  it('listWorkflows handles >32k workflows via chunked rollup queries', async () => {
    await seedWorkflows(adapter);

    const workflows = adapter.listWorkflows();
    expect(workflows).toHaveLength(WORKFLOW_COUNT_ABOVE_LIMIT);
  });

  it('loadTasksForWorkflows handles >32k workflow IDs via chunked queries', async () => {
    await seedWorkflows(adapter);

    const workflowIds = Array.from({ length: WORKFLOW_COUNT_ABOVE_LIMIT }, (_, i) => `wf-${i}`);
    const tasks = adapter.loadTasksForWorkflows(workflowIds);
    expect(tasks).toHaveLength(0);
  });
});
