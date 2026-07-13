import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runHeadless } from '../headless.js';
import type { HeadlessDeps } from '../headless.js';
import type { CommandService, Orchestrator } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { MessageBus } from '@invoker/transport';
import { LocalBus } from '@invoker/transport';

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(function () { return noopLogger; }),
};

describe('headless repair-review-gate-ci', () => {
  let mockDeps: HeadlessDeps;
  let stdoutWrites: string[];
  let repairReviewGateCiMock = vi.fn(async () => ({
    status: 'queued' as const,
    reason: 'queued',
    message: 'Queued CI repair for PR 123 on wf-1/merge.',
    prNumber: '123',
    workflowId: 'wf-1',
    taskId: 'wf-1/merge',
  }));
  beforeEach(() => {
    stdoutWrites = [];
    repairReviewGateCiMock = vi.fn(async () => ({
      status: 'queued' as const,
      reason: 'queued',
      message: 'Queued CI repair for PR 123 on wf-1/merge.',
      prNumber: '123',
      workflowId: 'wf-1',
      taskId: 'wf-1/merge',
    }));
    mockDeps = {
      logger: noopLogger,
      orchestrator: {} as unknown as Orchestrator,
      persistence: {} as unknown as SQLiteAdapter,
      commandService: {} as unknown as CommandService,
      executorRegistry: {} as unknown as HeadlessDeps['executorRegistry'],
      messageBus: new LocalBus() as MessageBus,
      repoRoot: '/fake/repo',
      invokerConfig: {} as HeadlessDeps['invokerConfig'],
      initServices: vi.fn(async () => {}),
      repairReviewGateCi: repairReviewGateCiMock,
    } as HeadlessDeps;
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delegates to the repair callback and prints its message', async () => {
    await runHeadless(['repair-review-gate-ci', '123'], mockDeps);

    expect(repairReviewGateCiMock).toHaveBeenCalledWith('123');
    expect(stdoutWrites[0]).toBe('Queued CI repair for PR 123 on wf-1/merge.\n');
  });

  it('requires a PR argument', async () => {
    await expect(runHeadless(['repair-review-gate-ci'], mockDeps)).rejects.toThrow(/repair-review-gate-ci/);
  });
});
