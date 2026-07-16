import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommandService, Orchestrator } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { MessageBus } from '@invoker/transport';
import { LocalBus } from '@invoker/transport';

import type { HeadlessDeps } from '../headless.js';
import { runHeadless } from '../headless.js';

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(function () { return noopLogger; }),
};

describe('headless repair-review-gate-merge-conflict', () => {
  let mockDeps: HeadlessDeps;
  let stdoutWrites: string[];
  let repairReviewGateMergeConflictMock = vi.fn(async () => ({
    status: 'queued' as const,
    reason: 'queued',
    message: 'Queued merge-conflict repair for PR 123 on wf-1/merge.',
    prNumber: '123',
    workflowId: 'wf-1',
    taskId: 'wf-1/merge',
  }));

  beforeEach(() => {
    stdoutWrites = [];
    repairReviewGateMergeConflictMock = vi.fn(async () => ({
      status: 'queued' as const,
      reason: 'queued',
      message: 'Queued merge-conflict repair for PR 123 on wf-1/merge.',
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
      repairReviewGateMergeConflict: repairReviewGateMergeConflictMock,
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
    await runHeadless(['repair-review-gate-merge-conflict', '123'], mockDeps);

    expect(repairReviewGateMergeConflictMock).toHaveBeenCalledWith('123');
    expect(stdoutWrites[0]).toBe('Queued merge-conflict repair for PR 123 on wf-1/merge.\n');
  });

  it('requires a PR argument', async () => {
    await expect(runHeadless(['repair-review-gate-merge-conflict'], mockDeps)).rejects.toThrow(/repair-review-gate-merge-conflict/);
  });
});
