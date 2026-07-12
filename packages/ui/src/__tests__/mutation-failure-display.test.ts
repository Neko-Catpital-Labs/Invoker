import { describe, expect, it } from 'vitest';
import {
  mutationFailureBannerMessage,
  mutationFailureDetailMessage,
  mutationFailureTitle,
  shouldShowMutationFailureBanner,
} from '../lib/mutation-failure-display.js';

describe('shouldShowMutationFailureBanner', () => {
  it('hides the banner for task-scoped failures', () => {
    expect(shouldShowMutationFailureBanner({
      intentId: 1,
      workflowId: 'wf-1',
      channel: 'headless.exec',
      headlessCommand: 'fix',
      taskId: 'wf-1/task-alpha',
      message: 'SSH remote script failed',
      failedAt: '2026-07-09T00:00:00.000Z',
    })).toBe(false);
  });

  it('hides the banner for workflow-scoped failures', () => {
    expect(shouldShowMutationFailureBanner({
      intentId: 1,
      workflowId: 'wf-1',
      channel: 'invoker:recreate',
      message: 'recreate failed',
      failedAt: '2026-07-09T00:00:00.000Z',
    })).toBe(false);
  });
});

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
});

describe('mutationFailureBannerMessage', () => {
  it('keeps only a short first-line summary', () => {
    expect(mutationFailureBannerMessage({
      intentId: 1,
      workflowId: '',
      channel: 'unknown',
      message: 'SSH remote script failed\nSTDOUT:\n{"type":"error"}',
      failedAt: '2026-07-09T00:00:00.000Z',
    })).toBe('SSH remote script failed');
  });
});

describe('mutationFailureDetailMessage', () => {
  it('strips the Error prefix and stack trace but keeps the full body', () => {
    expect(mutationFailureDetailMessage({
      intentId: 1,
      workflowId: 'wf-1',
      channel: 'invoker:approve',
      taskId: 'wf-1/task-alpha',
      message: 'Error: SSH target "remote" cannot run codex\n    at Object.run (file.ts:1:1)',
      failedAt: '2026-07-09T00:00:00.000Z',
    })).toBe('SSH target "remote" cannot run codex');
  });
});
