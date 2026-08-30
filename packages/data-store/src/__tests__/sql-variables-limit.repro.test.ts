import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from '../sqlite-adapter.js';

const SQLITE_MAX_VARIABLE_NUMBER = 32766;
const WORKFLOW_COUNT_ABOVE_LIMIT = SQLITE_MAX_VARIABLE_NUMBER + 100;

describe('SQL variables limit (ui-read-scale proof)', () => {
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

  it.fails('loadWorkflowTaskSnapshot throws "too many SQL variables" at >32766 workflows', async () => {
    for (let i = 0; i < WORKFLOW_COUNT_ABOVE_LIMIT; i++) {
      adapter.saveWorkflow({
        id: `wf-${i}`,
        name: `Workflow ${i}`,
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
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

    const snapshot = adapter.loadWorkflowTaskSnapshot();
    expect(snapshot.workflows).toHaveLength(WORKFLOW_COUNT_ABOVE_LIMIT);
  });

  it.fails('listWorkflows → loadWorkflowRollups throws at >32766 workflows', async () => {
    for (let i = 0; i < WORKFLOW_COUNT_ABOVE_LIMIT; i++) {
      adapter.saveWorkflow({
        id: `wf-${i}`,
        name: `Workflow ${i}`,
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    const workflows = adapter.listWorkflows();
    expect(workflows).toHaveLength(WORKFLOW_COUNT_ABOVE_LIMIT);
  });

  it.fails('loadTasksForWorkflows throws at >32766 workflow IDs', async () => {
    for (let i = 0; i < WORKFLOW_COUNT_ABOVE_LIMIT; i++) {
      adapter.saveWorkflow({
        id: `wf-${i}`,
        name: `Workflow ${i}`,
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    const workflowIds = Array.from({ length: WORKFLOW_COUNT_ABOVE_LIMIT }, (_, i) => `wf-${i}`);
    const tasks = adapter.loadTasksForWorkflows(workflowIds);
    expect(tasks).toHaveLength(0);
  });
});
