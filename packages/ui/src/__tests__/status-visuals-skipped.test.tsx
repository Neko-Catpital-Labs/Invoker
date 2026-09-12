import { describe, expect, it } from 'vitest';
import { STATUS_LABEL, STATUS_STYLE } from '../components/HistoryView.js';
import { getStatusVisual, STATUS_VISUALS } from '../lib/status-colors.js';
import { formatStatusLabel } from '../lib/colors.js';
import {
  ATTENTION_TASK_STATUS,
  RUNNING_TASK_STATUS,
} from '../lib/workflow-progress-surfaces.js';

describe('skipped status renderer vocabulary', () => {
  it('renders skipped as a muted terminal status across status maps', () => {
    expect(STATUS_VISUALS.skipped).toEqual({
      ...getStatusVisual('stale'),
      text: 'text-neutral-500',
      dot: 'bg-neutral-600',
      rail: 'bg-neutral-600',
      inline: { bg: '#171717', border: 'rgba(255,255,255,0.08)', text: '#737373' },
      active: false,
      pulse: false,
    });
    expect(formatStatusLabel('skipped')).toBe('Skipped');
    expect(STATUS_LABEL.skipped).toBe('Skipped');
    expect(STATUS_STYLE.skipped).toBe('bg-gray-700 text-gray-300');
    expect(ATTENTION_TASK_STATUS.skipped).toBeUndefined();
    expect(RUNNING_TASK_STATUS.skipped).toBeUndefined();
  });
});
