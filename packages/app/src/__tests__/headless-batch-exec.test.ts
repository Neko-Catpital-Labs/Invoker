import { describe, expect, it, vi } from 'vitest';
import { executeNoTrackHeadlessBatch, type HeadlessExecMutationPayload } from '../headless-batch-exec.js';

describe('executeNoTrackHeadlessBatch', () => {
  it('queues multiple no-track workflow mutations and returns per-item acknowledgements', () => {
    const classify = vi.fn((payload: HeadlessExecMutationPayload) => ({
      workflowId: payload.args[1],
      priority: 'high' as const,
    }));
    let nextIntentId = 100;
    const submit = vi.fn(() => nextIntentId++);

    const results = executeNoTrackHeadlessBatch(
      {
        noTrack: true,
        items: [
          { label: 'first', workflowId: 'wf-1', args: ['rebase-recreate', 'wf-1'] },
          { label: 'second', workflowId: 'wf-2', args: ['rebase-recreate', 'wf-2'] },
        ],
      },
      { classify, submit },
    );

    expect(results).toEqual([
      {
        label: 'first',
        workflowId: 'wf-1',
        args: ['rebase-recreate', 'wf-1'],
        ok: true,
        response: { ok: true, intentId: 100 },
      },
      {
        label: 'second',
        workflowId: 'wf-2',
        args: ['rebase-recreate', 'wf-2'],
        ok: true,
        response: { ok: true, intentId: 101 },
      },
    ]);
    expect(submit).toHaveBeenNthCalledWith(
      1,
      'wf-1',
      'high',
      'headless.exec',
      [{ args: ['rebase-recreate', 'wf-1'], waitForApproval: undefined, noTrack: true, traceId: undefined }],
      { deferDrain: true },
    );
    expect(submit).toHaveBeenNthCalledWith(
      2,
      'wf-2',
      'high',
      'headless.exec',
      [{ args: ['rebase-recreate', 'wf-2'], waitForApproval: undefined, noTrack: true, traceId: undefined }],
      { deferDrain: true },
    );
  });

  it('reports per-item failures without aborting the rest of the batch', () => {
    const classify = vi.fn((payload: HeadlessExecMutationPayload) => ({
      workflowId: payload.args[1]?.startsWith('wf-') ? payload.args[1] : undefined,
      priority: 'high' as const,
    }));
    const submit = vi.fn(() => 42);

    const results = executeNoTrackHeadlessBatch(
      {
        noTrack: true,
        items: [
          { label: 'bad-args', args: 'rebase-recreate wf-1' },
          { label: 'bad-target', args: ['rebase-recreate', 'missing'] },
          { label: 'good', args: ['rebase-recreate', 'wf-1'] },
        ],
      },
      { classify, submit },
    );

    expect(results).toEqual([
      {
        label: 'bad-args',
        workflowId: undefined,
        args: [],
        ok: false,
        error: 'Invalid batch item: args must be a string array',
      },
      {
        label: 'bad-target',
        workflowId: undefined,
        args: ['rebase-recreate', 'missing'],
        ok: false,
        error: 'Fire-and-forget headless.exec could not be queued: workflow-not-resolved',
      },
      {
        label: 'good',
        workflowId: 'wf-1',
        args: ['rebase-recreate', 'wf-1'],
        ok: true,
        response: { ok: true, intentId: 42 },
      },
    ]);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('throws retryable queue errors so the caller can retry the batch', () => {
    const classify = vi.fn(() => ({
      workflowId: 'wf-1',
      priority: 'high' as const,
    }));
    const submit = vi.fn(() => {
      throw new Error('database is locked');
    });

    expect(() => executeNoTrackHeadlessBatch(
      {
        noTrack: true,
        items: [{ label: 'locked', args: ['rebase-recreate', 'wf-1'] }],
      },
      { classify, submit },
    )).toThrow('database is locked');
  });
});
