import { describe, expect, it } from 'vitest';
import { mutationFailureTitle } from '../lib/mutation-failure-display.js';

describe('mutationFailureTitle', () => {
  it('maps headless fix failures to a friendly title', () => {
    expect(mutationFailureTitle({
      intentId: 1,
      workflowId: '',
      channel: 'headless.exec',
      headlessCommand: 'fix',
      message: 'boom',
      failedAt: '2026-07-09T00:00:00.000Z',
    })).toBe('Fix failed');
  });

  it('maps approve channel failures to a friendly title', () => {
    expect(mutationFailureTitle({
      intentId: 1,
      workflowId: 'wf-1',
      channel: 'invoker:approve',
      message: 'approve failed',
      failedAt: '2026-07-09T00:00:00.000Z',
    })).toBe('Approve failed');
  });

  it('falls back to the channel name for unknown channels', () => {
    expect(mutationFailureTitle({
      intentId: 1,
      workflowId: 'wf-1',
      channel: 'unknown-channel',
      message: 'unknown failure',
      failedAt: '2026-07-09T00:00:00.000Z',
    })).toBe('Mutation failed (unknown-channel)');
  });
});
