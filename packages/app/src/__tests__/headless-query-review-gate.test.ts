import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runHeadless } from '../headless.js';
import {
  makeHeadlessDeps,
  makeReviewGateArtifact,
  makeReviewGateRepairHarness,
  makeReviewGateTask,
} from './review-gate-ci-repair-test-harness.js';

describe('headless query review-gate', () => {
  let stdoutSpy: any;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('prints mapped review-gate CI repair availability as JSON', async () => {
    const harness = makeReviewGateRepairHarness();

    await runHeadless(['query', 'review-gate', '123', '--output', 'json'], makeHeadlessDeps(harness));

    const parsed = JSON.parse(stdoutSpy.mock.calls.map((call) => call[0]).join(''));
    expect(parsed).toMatchObject({
      state: 'mapped',
      target: '123',
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
        failedChecks: [
          { name: 'unit' },
          { name: 'lint' },
        ],
      },
    });
    expect(parsed.ciRepair.actionKey).toContain('ci-failure:wf-1/merge:123:sha-1:');
  });

  it('prints unmapped as JSON when no workflow is tied to the PR', async () => {
    const harness = makeReviewGateRepairHarness([]);

    await runHeadless(['query', 'review-gate', '999', '--output', 'json'], makeHeadlessDeps(harness));

    expect(JSON.parse(stdoutSpy.mock.calls.map((call) => call[0]).join(''))).toEqual({
      state: 'unmapped',
      target: '999',
      prNumber: '999',
    });
  });

  it('prints merge-conflict state in text output without advertising CI repair availability', async () => {
    const task = makeReviewGateTask({
      execution: {
        reviewGate: {
          activeGeneration: 2,
          artifacts: [makeReviewGateArtifact({ mergeState: 'dirty' })],
        },
      },
    });
    const harness = makeReviewGateRepairHarness([task]);

    await runHeadless(['query', 'review-gate', 'https://github.com/owner/repo/pull/123'], makeHeadlessDeps(harness));

    const output = stdoutSpy.mock.calls.map((call) => call[0]).join('');
    expect(output).toContain('Review gate https://github.com/owner/repo/pull/123');
    expect(output).toContain('ciRepair: merge_conflict (merge-conflict)');
    expect(output).not.toContain('latestAction:');
  });

  it('prints the merge task id in label output for mapped PRs', async () => {
    const harness = makeReviewGateRepairHarness();

    await runHeadless(['query', 'review-gate', '123', '--output', 'label'], makeHeadlessDeps(harness));

    expect(stdoutSpy.mock.calls.map((call) => call[0]).join('')).toBe('wf-1/merge\n');
  });
});
