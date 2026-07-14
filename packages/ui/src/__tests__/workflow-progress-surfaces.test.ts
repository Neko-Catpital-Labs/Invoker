import { describe, expect, it } from 'vitest';
import type { QueueStatus } from '@invoker/contracts';
import { makeUITask } from './helpers/mock-invoker.js';
import { getRunningTaskEntries } from '../lib/workflow-progress-surfaces.js';
import type { WorkflowMeta } from '../types.js';

describe('workflow progress surfaces', () => {
  it('keeps live running tasks visible when queue polling points at a missing task', () => {
    const workflow: WorkflowMeta = {
      id: 'wf-alpha',
      name: 'Alpha',
      status: 'running',
    };
    const alpha = makeUITask({
      id: 'task-alpha',
      description: 'First test task',
      status: 'running',
      workflowId: workflow.id,
    });
    const tasks = new Map([[alpha.id, alpha]]);
    const workflows = new Map([[workflow.id, workflow]]);
    const queueStatus: QueueStatus = {
      maxConcurrency: 1,
      runningCount: 1,
      running: [{ taskId: 'ghost-task', description: 'Ghost task' }],
      queued: [],
    };

    const entries = getRunningTaskEntries(tasks, workflows, queueStatus);
    expect(entries.map(({ task }) => task.id)).toEqual(['task-alpha']);
    expect(entries[0]?.workflow?.id).toBe('wf-alpha');
  });
});
