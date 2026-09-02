import { describe, expect, it } from 'vitest';
import { STATUS_LABEL, STATUS_STYLE } from '../components/HistoryView.js';
import { formatStatusLabel } from '../lib/colors.js';
import {
  ATTENTION_STATUS_PRIORITY,
  ATTENTION_TASK_STATUS,
  RUNNING_TASK_STATUS,
  TASK_STATUS_PRIORITY,
} from '../lib/workflow-progress-surfaces.js';
import { STATUS_VISUALS } from '../lib/status-colors.js';

describe('skipped status visual vocabulary', () => {
  it('defines a muted terminal visual and display label', () => {
    expect(STATUS_VISUALS.skipped).toMatchObject({
      text: 'text-neutral-500',
      dot: 'bg-neutral-600',
      rail: 'bg-neutral-600',
      active: false,
      pulse: false,
    });
    expect(formatStatusLabel('skipped')).toBe('Skipped');
  });

  it('includes skipped in HistoryView and excludes it from attention and running', () => {
    expect(STATUS_LABEL.skipped).toBe('Skipped');
    expect(STATUS_STYLE.skipped).toBe('bg-gray-700 text-gray-300');
    expect(ATTENTION_STATUS_PRIORITY.skipped).toBeUndefined();
    expect(ATTENTION_TASK_STATUS.skipped).toBeUndefined();
    expect(RUNNING_TASK_STATUS.skipped).toBeUndefined();
    expect(TASK_STATUS_PRIORITY.skipped).toBe(99);
  });
});
