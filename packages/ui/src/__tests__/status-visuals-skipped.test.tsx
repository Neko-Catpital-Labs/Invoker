import { describe, expect, it } from 'vitest';
import { STATUS_VISUALS } from '../lib/status-colors.js';
import { formatStatusLabel } from '../lib/colors.js';
import { STATUS_LABEL } from '../components/HistoryView.js';
import {
  ATTENTION_TASK_STATUS,
  isAttentionTask,
  isRunningTask,
  RUNNING_TASK_STATUS,
} from '../lib/workflow-progress-surfaces.js';
import type { TaskState } from '../types.js';

const skippedTask: TaskState = {
  id: 'task-skipped',
  description: 'Skipped task',
  status: 'skipped' as TaskState['status'],
  dependencies: [],
  createdAt: new Date(0),
  config: {},
  execution: {},
  taskStateVersion: 1,
};

describe('skipped status visuals', () => {
  it('is represented as a muted terminal status across status maps', () => {
    expect(STATUS_VISUALS['skipped']).toMatchObject({ active: false, pulse: false });
    expect(formatStatusLabel('skipped' as TaskState['status'])).toBe('Skipped');
    expect(STATUS_LABEL['skipped']).toBe('Skipped');
    expect(ATTENTION_TASK_STATUS.skipped).toBeUndefined();
    expect(RUNNING_TASK_STATUS.skipped).toBeUndefined();
    expect(isAttentionTask(skippedTask)).toBe(false);
    expect(isRunningTask(skippedTask)).toBe(false);
  });
});
