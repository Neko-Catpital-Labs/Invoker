import { describe, expect, it } from 'vitest';
import { ciFailureActionKey, parseFixWithAgentMutationArgs } from '@invoker/execution-engine';

import {
  formatReviewGateCiRepairResult,
  queryReviewGate,
  runReviewGateCiRepairCommand,
} from '../review-gate-ci-repair-command.js';
import {
  failedChecks,
  makeReviewGateArtifact,
  makeReviewGateRepairHarness,
  makeReviewGateTask,
} from './review-gate-ci-repair-test-harness.js';

describe('review-gate CI repair command', () => {
  it('queues a workflow-scoped CI repair intent for a mapped review gate PR number', async () => {
    const harness = makeReviewGateRepairHarness();

    const result = await runReviewGateCiRepairCommand('123', {
      store: harness.store,
      submitter: harness.submitter,
      logger: harness.logger,
      defaultAutoFixRetries: 2,
      getAutoFixAgent: () => 'codex',
      getAutoFixExecutionModel: () => 'openai/gpt-5.2',
      attemptLedger: harness.attemptLedger,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    if (result.decision === 'unmapped') throw new Error('expected mapped result');
    expect(result).toMatchObject({
      decision: 'queued',
      reason: 'queued',
      target: '123',
      prNumber: '123',
      workflowId: 'wf-1',
      workflowName: 'Workflow one',
      taskId: 'wf-1/merge',
      taskStatus: 'review_ready',
      reviewId: '123',
      reviewUrl: 'https://github.com/owner/repo/pull/123',
      headSha: 'sha-1',
      intentId: 42,
    });
    expect(result.failedChecks.map((check) => check.name)).toEqual(['unit', 'lint']);
    expect(harness.submit).toHaveBeenCalledTimes(1);
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
        executionModel: 'openai/gpt-5.2',
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
    expect(parsed.context.reviewGateContext?.fixContext).toContain('unit');
  });

  it('reports unmapped when no workflow merge task is tied to the PR', async () => {
    const harness = makeReviewGateRepairHarness([]);

    const result = await runReviewGateCiRepairCommand('999', {
      store: harness.store,
      submitter: harness.submitter,
      logger: harness.logger,
      defaultAutoFixRetries: 2,
      attemptLedger: harness.attemptLedger,
    });

    expect(result).toEqual({
      decision: 'unmapped',
      reason: 'no-matching-review-gate',
      target: '999',
      prNumber: '999',
    });
    expect(formatReviewGateCiRepairResult(result)).toContain('unmapped');
    expect(harness.submit).not.toHaveBeenCalled();
  });

  it('skips merge-conflict review gates without queuing a CI repair', async () => {
    const task = makeReviewGateTask({
      execution: {
        reviewGate: {
          activeGeneration: 2,
          artifacts: [makeReviewGateArtifact({ mergeState: 'dirty' })],
        },
      },
    });
    const harness = makeReviewGateRepairHarness([task]);

    const result = await runReviewGateCiRepairCommand('https://github.com/owner/repo/pull/123', {
      store: harness.store,
      submitter: harness.submitter,
      logger: harness.logger,
      defaultAutoFixRetries: 2,
      attemptLedger: harness.attemptLedger,
    });

    expect(result).toMatchObject({
      decision: 'skipped',
      reason: 'merge-conflict',
      workflowId: 'wf-1',
      taskId: 'wf-1/merge',
    });
    expect(harness.submit).not.toHaveBeenCalled();
  });

  it('skips when a mapped review gate has no current failed check artifact', async () => {
    const task = makeReviewGateTask({
      execution: {
        reviewGate: {
          activeGeneration: 2,
          artifacts: [makeReviewGateArtifact({ generation: 1 })],
        },
      },
    });
    const harness = makeReviewGateRepairHarness([task]);

    const result = await runReviewGateCiRepairCommand('123', {
      store: harness.store,
      submitter: harness.submitter,
      logger: harness.logger,
      defaultAutoFixRetries: 2,
      attemptLedger: harness.attemptLedger,
    });

    expect(result).toMatchObject({
      decision: 'skipped',
      reason: 'review-gate-artifact-not-current',
      workflowId: 'wf-1',
      taskId: 'wf-1/merge',
    });
    expect(harness.submit).not.toHaveBeenCalled();
  });

  it('queries the mapped review gate and exposes the latest CI repair action', async () => {
    const harness = makeReviewGateRepairHarness();

    const queued = await runReviewGateCiRepairCommand('123', {
      store: harness.store,
      submitter: harness.submitter,
      logger: harness.logger,
      defaultAutoFixRetries: 2,
      getAutoFixAgent: () => 'codex',
      attemptLedger: harness.attemptLedger,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    if (queued.decision === 'unmapped') throw new Error('expected mapped result');
    const queried = queryReviewGate('https://github.com/owner/repo/pull/123', { store: harness.store });
    expect(queried).toMatchObject({
      state: 'mapped',
      prNumber: '123',
      workflowId: 'wf-1',
      workflowName: 'Workflow one',
      taskId: 'wf-1/merge',
      taskStatus: 'review_ready',
      reviewId: '123',
      reviewUrl: 'https://github.com/owner/repo/pull/123',
      ciRepair: {
        state: 'available',
        headSha: 'sha-1',
        failedChecks,
        actionKey: queued.actionKey,
        action: {
          status: 'queued',
          summary: 'Queued CI repair with agent',
          intentId: '42',
          agentName: 'codex',
        },
      },
    });
    expect(queued.actionKey).toBe(ciFailureActionKey({
      taskId: 'wf-1/merge',
      reviewId: '123',
      headSha: 'sha-1',
      failedChecks,
    }));
  });
});
