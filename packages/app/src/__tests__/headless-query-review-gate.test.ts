import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runHeadless } from '../headless.js';
import type { HeadlessDeps } from '../headless.js';
import type { Orchestrator, CommandService } from '@invoker/workflow-core';
import type { ReviewGateLookup, SQLiteAdapter } from '@invoker/data-store';
import type { MessageBus } from '@invoker/transport';
import { LocalBus } from '@invoker/transport';

const noopLogger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: vi.fn(function () { return noopLogger; }),
};

const record: ReviewGateLookup = {
  workflowId: 'wf-42',
  mergeTaskId: '__merge__wf-42',
  reviewId: '999',
  reviewUrl: 'https://github.com/owner/repo/pull/999',
  branch: 'stack/edbert/plan/feature--abc',
  baseBranch: 'main',
  workflowStatus: 'running',
  workflowGeneration: 2,
  mergeTaskStatus: 'running',
  selectedAttemptId: 'wf-42/__merge__wf-42-attempt-1',
};

describe('headless query review-gate', () => {
  let mockDeps: HeadlessDeps;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let findReviewGateByPr: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    findReviewGateByPr = vi.fn((pr: string) => (pr === '999' ? record : undefined));
    mockDeps = {
      logger: noopLogger,
      orchestrator: {} as unknown as Orchestrator,
      persistence: {
        readOnly: true,
        findReviewGateByPr,
      } as unknown as SQLiteAdapter,
      commandService: {} as unknown as CommandService,
      executorRegistry: {} as unknown as HeadlessDeps['executorRegistry'],
      messageBus: new LocalBus() as MessageBus,
      repoRoot: '/fake/repo',
      invokerConfig: {} as unknown as HeadlessDeps['invokerConfig'],
      initServices: vi.fn(async () => {}),
    } as unknown as HeadlessDeps;
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('prints the resolved record as JSON', async () => {
    await runHeadless(['query', 'review-gate', '999', '--output', 'json'], mockDeps);
    expect(findReviewGateByPr).toHaveBeenCalledWith('999');
    const output = stdoutSpy.mock.calls[0][0] as string;
    expect(JSON.parse(output)).toEqual(record);
  });

  it('parses the PR number out of a full PR URL', async () => {
    await runHeadless(
      ['query', 'review-gate', 'https://github.com/owner/repo/pull/999', '--output', 'json'],
      mockDeps,
    );
    expect(findReviewGateByPr).toHaveBeenCalledWith('999');
  });

  it('prints an empty object and exits cleanly when no workflow matches', async () => {
    await runHeadless(['query', 'review-gate', '123456', '--output', 'json'], mockDeps);
    expect(findReviewGateByPr).toHaveBeenCalledWith('123456');
    const output = stdoutSpy.mock.calls[0][0] as string;
    expect(JSON.parse(output)).toEqual({});
  });

  it('emits the workflow id for label output and empty for a miss', async () => {
    await runHeadless(['query', 'review-gate', '999', '--output', 'label'], mockDeps);
    expect((stdoutSpy.mock.calls[0][0] as string).trim()).toBe('wf-42');

    stdoutSpy.mockClear();
    await runHeadless(['query', 'review-gate', '123456', '--output', 'label'], mockDeps);
    expect((stdoutSpy.mock.calls[0][0] as string).trim()).toBe('');
  });

  it('emits a single JSONL line for the record and nothing for a miss', async () => {
    await runHeadless(['query', 'review-gate', '999', '--output', 'jsonl'], mockDeps);
    const line = (stdoutSpy.mock.calls[0][0] as string).trim();
    expect(JSON.parse(line)).toEqual(record);

    stdoutSpy.mockClear();
    await runHeadless(['query', 'review-gate', '123456', '--output', 'jsonl'], mockDeps);
    expect((stdoutSpy.mock.calls[0][0] as string).trim()).toBe('');
  });
  it('prints a human text line by default and a clear miss message', async () => {
    await runHeadless(['query', 'review-gate', '999'], mockDeps);
    const line = stdoutSpy.mock.calls[0][0] as string;
    expect(line).toContain('wf-42');
    expect(line).toContain('running');
    expect(line).not.toContain('{');

    stdoutSpy.mockClear();
    await runHeadless(['query', 'review-gate', '123456', '--output', 'text'], mockDeps);
    expect(stdoutSpy.mock.calls[0][0] as string).toContain('No Invoker workflow found for PR 123456');
  });


  it('errors when no PR argument is given', async () => {
    await expect(runHeadless(['query', 'review-gate'], mockDeps)).rejects.toThrow(/review-gate/);
  });
});
