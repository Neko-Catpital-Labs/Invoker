import { describe, expect, it, vi } from 'vitest';
import { buildTaskGraphSnapshot } from '../web/task-graph-snapshot.js';

function makeTask(id: string) {
  return {
    id,
    description: id,
    status: 'pending',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: {},
    execution: {},
  };
}

describe('buildTaskGraphSnapshot', () => {
  it('returns tasks and workflows from one persistence snapshot when available', () => {
    const task = makeTask('wf-1/task-1');
    const workflow = { id: 'wf-1', name: 'Workflow 1', status: 'running' };
    const syncAllFromDb = vi.fn();
    const getAllTasks = vi.fn(() => {
      throw new Error('getAllTasks fallback should not run when a persistence snapshot exists');
    });
    const listWorkflows = vi.fn(() => {
      throw new Error('listWorkflows fallback should not run when a persistence snapshot exists');
    });
    const loadWorkflowTaskSnapshot = vi.fn(() => ({
      workflows: [workflow],
      tasks: [task],
      tasksByWorkflowId: new Map([[workflow.id, [task]]]),
    }));

    const snapshot = buildTaskGraphSnapshot({
      orchestrator: {
        syncAllFromDb,
        getAllTasks,
      } as never,
      persistence: {
        listWorkflows,
        loadWorkflowTaskSnapshot,
      } as never,
      getStreamSequence: () => 17,
    });

    expect(snapshot).toEqual({
      tasks: [task],
      workflows: [workflow],
      streamSequence: 17,
    });
    expect(syncAllFromDb).toHaveBeenCalledTimes(1);
    expect(loadWorkflowTaskSnapshot).toHaveBeenCalledTimes(1);
    expect(getAllTasks).not.toHaveBeenCalled();
    expect(listWorkflows).not.toHaveBeenCalled();
  });
});
