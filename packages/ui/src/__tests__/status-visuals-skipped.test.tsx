import { describe, expect, it } from 'vitest';
import { formatStatusLabel } from '../lib/colors.js';
import { STATUS_VISUALS } from '../lib/status-colors.js';
import {
  ATTENTION_TASK_STATUS,
  RUNNING_TASK_STATUS,
  WORKFLOW_STATUS_PRIORITY,
} from '../lib/workflow-progress-surfaces.js';
import { STATUS_LABEL } from '../components/HistoryView.js';

describe('skipped status vocabulary', () => {
  it('renders skipped as a muted terminal status across status maps', () => {
    expect(STATUS_VISUALS.skipped).toMatchObject({ active: false, pulse: false });
    expect(formatStatusLabel('skipped')).toBe('Skipped');
    expect(STATUS_LABEL.skipped).toBe('Skipped');
    expect(WORKFLOW_STATUS_PRIORITY.skipped).toBeGreaterThan(WORKFLOW_STATUS_PRIORITY.stale);
    expect(ATTENTION_TASK_STATUS.skipped).toBeUndefined();
    expect(RUNNING_TASK_STATUS.skipped).toBeUndefined();
  });
});
