import { describe, it, expect } from 'vitest';
import { formatStatusLabel } from '../lib/colors.js';
import { STATUS_VISUALS } from '../lib/status-colors.js';

describe('skipped status UI coverage', () => {
  it('has a status visual entry', () => {
    expect(STATUS_VISUALS.skipped).toBeDefined();
    expect(STATUS_VISUALS.skipped.active).toBe(false);
    expect(STATUS_VISUALS.skipped.pulse).toBe(false);
  });

  it('has a formatted label', () => {
    expect(formatStatusLabel('skipped')).toBe('Skipped');
  });

  it('has a HistoryView label', async () => {
    const { STATUS_LABEL } = await import('../components/HistoryView.js');
    expect(STATUS_LABEL.skipped).toBe('Skipped');
  });

  it('is absent from the attention and running task-status maps', async () => {
    const surfaces = await import('../lib/workflow-progress-surfaces.js');
    expect(
      surfaces.isAttentionTask({
        status: 'skipped',
        config: {},
      } as never),
    ).toBe(false);
    expect(
      surfaces.isRunningTask({
        status: 'skipped',
        config: {},
      } as never),
    ).toBe(false);
  });
});
