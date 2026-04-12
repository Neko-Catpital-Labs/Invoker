import { describe, it, expect, vi } from 'vitest';
import { withCoalescedWorkflowReset } from '../workflow-reset-coalescer.js';

describe('workflow-reset-coalescer', () => {
  it('coalesces concurrent resets for the same workflow id', async () => {
    const run = vi.fn(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      return 'ok';
    });

    const [r1, r2] = await Promise.all([
      withCoalescedWorkflowReset('wf-1', run),
      withCoalescedWorkflowReset('wf-1', run),
    ]);

    expect(run).toHaveBeenCalledTimes(1);
    expect([r1.coalesced, r2.coalesced].sort()).toEqual([false, true]);
    expect(r1.value).toBe('ok');
    expect(r2.value).toBe('ok');
  });

  it('does not coalesce different workflow ids', async () => {
    const run = vi.fn(async () => 'ok');

    const [a, b] = await Promise.all([
      withCoalescedWorkflowReset('wf-a', run),
      withCoalescedWorkflowReset('wf-b', run),
    ]);

    expect(run).toHaveBeenCalledTimes(2);
    expect(a.coalesced).toBe(false);
    expect(b.coalesced).toBe(false);
  });
});
