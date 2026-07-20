import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({
  loadConfig: () => ({ autoFixAgent: 'codex' }),
  resolveSecretsFilePath: () => undefined,
}));

import { runHeadless } from '../headless.js';
import {
  makeHeadlessDeps,
  makeReviewGateArtifact,
  makeReviewGateRepairHarness,
  makeReviewGateTask,
} from './review-gate-ci-repair-test-harness.js';

describe('headless repair-review-gate-ci', () => {
  let stdoutSpy: any;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('queues CI repair for a workflow-mapped PR URL and prints the queued outcome', async () => {
    const harness = makeReviewGateRepairHarness();

    await runHeadless([
      'repair-review-gate-ci',
      'https://github.com/owner/repo/pull/123',
    ], makeHeadlessDeps(harness, harness.attemptLedger));

    expect(harness.submit).toHaveBeenCalledTimes(1);
    expect(stdoutSpy.mock.calls.map((call) => call[0]).join('')).toContain(
      'Review-gate CI repair queued for https://github.com/owner/repo/pull/123 (workflow wf-1, task wf-1/merge): intent 42.',
    );
  });

  it('prints unmapped without submitting when no workflow review gate matches the PR', async () => {
    const harness = makeReviewGateRepairHarness([]);

    await runHeadless(['repair-review-gate-ci', '999'], makeHeadlessDeps(harness));

    expect(harness.submit).not.toHaveBeenCalled();
    expect(stdoutSpy.mock.calls.map((call) => call[0]).join('')).toContain(
      'Review-gate CI repair unmapped for 999',
    );
  });

  it('prints skipped for merge conflicts and does not route through CI repair', async () => {
    const task = makeReviewGateTask({
      execution: {
        reviewGate: {
          activeGeneration: 2,
          artifacts: [makeReviewGateArtifact({ mergeState: 'dirty' })],
        },
      },
    });
    const harness = makeReviewGateRepairHarness([task]);

    await runHeadless(['repair-review-gate-ci', '123'], makeHeadlessDeps(harness));

    expect(harness.submit).not.toHaveBeenCalled();
    expect(stdoutSpy.mock.calls.map((call) => call[0]).join('')).toContain(
      'Review-gate CI repair skipped for https://github.com/owner/repo/pull/123 (workflow wf-1, task wf-1/merge): merge-conflict.',
    );
  });

  it('requires a repair submitter in the runtime dependencies', async () => {
    const harness = makeReviewGateRepairHarness();
    const deps = makeHeadlessDeps(harness);
    delete deps.reviewGateCiRepairSubmitter;

    await expect(runHeadless(['repair-review-gate-ci', '123'], deps)).rejects.toThrow(
      'Review-gate CI repair submitter is unavailable',
    );
  });
});
