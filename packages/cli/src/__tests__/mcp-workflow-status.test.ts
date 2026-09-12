import { describe, expect, it } from 'vitest';
import { summarizeTaskStatuses, workflowTasksSettled } from '../mcp-workflow-status.js';

describe('mcp-workflow-status skipped tasks', () => {
  it('settles skipped-only workflows and counts skipped tasks', () => {
    const tasks = [{ id: 'task-1', status: 'skipped' }];
    expect(workflowTasksSettled(tasks)).toBe(true);
    expect(summarizeTaskStatuses(tasks).skipped).toBe(1);
  });
});
