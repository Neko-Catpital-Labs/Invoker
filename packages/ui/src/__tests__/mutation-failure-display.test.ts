import { describe, expect, it } from 'vitest';
import {
  mutationFailureBannerMessage,
  mutationFailureHasTaskTarget,
  mutationFailureTitle,
} from '../lib/mutation-failure-display.js';

describe('mutationFailureTitle', () => {
  it('maps headless fix failures to a friendly title', () => {
    expect(mutationFailureTitle({
      intentId: 1,
      workflowId: 'wf-1',
      channel: 'headless.exec',
      headlessCommand: 'fix',
      message: 'boom',
      failedAt: '2026-07-09T00:00:00.000Z',
    })).toBe('Fix failed');
  });
});

describe('mutationFailureBannerMessage', () => {
  it('shows a task-panel hint instead of verbose errors when the task is loaded', () => {
    const event = {
      intentId: 1,
      workflowId: 'wf-1',
      channel: 'headless.exec',
      headlessCommand: 'fix',
      taskId: 'wf-1/task-alpha',
      message: 'SSH remote script failed\nSTDOUT:\n{"type":"error"}',
      failedAt: '2026-07-09T00:00:00.000Z',
    };
    expect(mutationFailureHasTaskTarget(event)).toBe(true);
    expect(mutationFailureBannerMessage(event)).toBe('See the task panel for details.');
  });
});
