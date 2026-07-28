import { createRequire } from 'node:module';

import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { isNoTrackAcknowledgedResponse, requestExec } = require('../../../../scripts/headless-ipc.js');

describe('isNoTrackAcknowledgedResponse', () => {
  it('accepts the narrow { ok: true, intentId } mutation-ack shape', () => {
    expect(isNoTrackAcknowledgedResponse({ ok: true, intentId: 'intent-1' })).toBe(true);
    expect(isNoTrackAcknowledgedResponse({ ok: true, intentId: 42 })).toBe(true);
  });

  it('rejects { ok: true } with neither intentId nor workflowId', () => {
    expect(isNoTrackAcknowledgedResponse({ ok: true })).toBe(false);
  });

  it('accepts the real { workflowId, tasks } run-command shape with no ok field', () => {
    expect(isNoTrackAcknowledgedResponse({ workflowId: 'wf-1', tasks: [] })).toBe(true);
  });

  it('rejects a workflowId-only response missing tasks as a protocol violation', () => {
    expect(isNoTrackAcknowledgedResponse({ workflowId: 'wf-1' })).toBe(false);
  });

  it('rejects null, non-object, and empty responses', () => {
    expect(isNoTrackAcknowledgedResponse(null)).toBe(false);
    expect(isNoTrackAcknowledgedResponse(undefined)).toBe(false);
    expect(isNoTrackAcknowledgedResponse('ok')).toBe(false);
    expect(isNoTrackAcknowledgedResponse({})).toBe(false);
  });
});

describe('requestExec --no-track dispatch', () => {
  it('resolves instead of throwing for the real run-command response shape', async () => {
    const bus = {
      request: vi.fn().mockResolvedValue({
        workflowId: 'wf-abc',
        tasks: [],
        workflowIds: ['wf-abc'],
        workflowCount: 1,
        planName: 'demo-plan',
      }),
    };

    const result = await requestExec(
      bus,
      { args: ['run', 'plan.yaml'] },
      { noTrack: true, waitForApproval: false, timeoutMs: 0 },
    );

    expect(result.ok).toBe(true);
    expect(result.response.workflowId).toBe('wf-abc');
  });

  it('still throws when the owner never acknowledges the dispatch', async () => {
    const bus = {
      request: vi.fn().mockResolvedValue({ ok: true }),
    };

    await expect(
      requestExec(bus, { args: ['run', 'plan.yaml'] }, { noTrack: true, waitForApproval: false, timeoutMs: 0 }),
    ).rejects.toThrow(/was not queued/);
  });
});
