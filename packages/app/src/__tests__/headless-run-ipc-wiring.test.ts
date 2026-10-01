import { describe, expect, it, vi } from 'vitest';

import { acceptHeadlessRunAck } from '../headless-run-ack.js';

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
}

describe('acceptHeadlessRunAck', () => {
  it('passes through an ack that carries a workflow id', () => {
    const logger = makeLogger();
    const ack = { workflowId: 'wf-intake-1', planName: 'Intake Plan', tasks: [] };

    expect(acceptHeadlessRunAck(ack, 'gui', logger as never)).toBe(ack);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('fails the intake and logs the plan name when no workflow id was persisted', () => {
    const logger = makeLogger();

    expect(() => acceptHeadlessRunAck({ workflowId: '', planName: 'Intake Plan' }, 'standalone', logger as never))
      .toThrow(/plan "Intake Plan" produced no persisted workflow id/);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(String(logger.error.mock.calls[0]?.[0])).toContain('headless.run rejected mode=standalone');
    expect(String(logger.error.mock.calls[0]?.[0])).toContain('Intake Plan');
  });
});
