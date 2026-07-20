import { describe, expect, it } from 'vitest';
import { parseFixWithAgentMutationArgs } from '@invoker/execution-engine';

import { runReviewGateCiRepairCommand } from '../review-gate-ci-repair-command.js';
import {
  makeReviewGateRepairHarness,
  makeReviewGateTask,
} from './review-gate-ci-repair-test-harness.js';

describe('review-gate CI repair for review_ready merge tasks', () => {
  it('queues a fix-with-agent intent with review-gate context while preserving the command path status', async () => {
    const task = makeReviewGateTask({ status: 'review_ready' });
    const harness = makeReviewGateRepairHarness([task]);

    const result = await runReviewGateCiRepairCommand('123', {
      store: harness.store,
      submitter: harness.submitter,
      logger: harness.logger,
      defaultAutoFixRetries: 2,
      getAutoFixAgent: () => 'codex',
      attemptLedger: harness.attemptLedger,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    expect(result).toMatchObject({
      decision: 'queued',
      workflowId: 'wf-1',
      taskId: 'wf-1/merge',
      taskStatus: 'review_ready',
    });
    expect(task.status).toBe('review_ready');
    expect((harness.store as any).updateTask).toBeUndefined();
    expect(harness.submit).toHaveBeenCalledWith(
      'wf-1',
      'normal',
      'invoker:fix-with-agent',
      expect.any(Array),
    );

    const parsed = parseFixWithAgentMutationArgs(harness.submit.mock.calls[0][3]);
    expect(parsed).toMatchObject({
      taskId: 'wf-1/merge',
      agentName: 'codex',
      context: {
        autoFix: true,
        reviewGateContext: {
          reviewId: '123',
          generation: 2,
          selectedAttemptId: 'attempt-1',
          branch: 'feature/ci',
          headSha: 'sha-1',
        },
      },
    });
    expect(parsed.context.reviewGateContext?.fixContext).toContain('Review-gate CI failed');
    expect(parsed.context.reviewGateContext?.fixContext).toContain('Failed checks:');
  });
});
