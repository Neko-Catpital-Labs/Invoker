import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { acceptHeadlessRunAck } from '../headless-run-ack.js';

const mainSource = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');

function headlessRunHandlerBodies(source: string): string[] {
  const bodies: string[] = [];
  const marker = "messageBus.onRequest('headless.run'";
  let cursor = source.indexOf(marker);
  while (cursor !== -1) {
    bodies.push(source.slice(cursor, source.indexOf('});', cursor)));
    cursor = source.indexOf(marker, cursor + marker.length);
  }
  return bodies;
}

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

describe('main.ts headless.run wiring', () => {
  it('registers a handler for both the standalone and the gui owner', () => {
    const bodies = headlessRunHandlerBodies(mainSource);
    expect(bodies).toHaveLength(2);
    expect(bodies.filter((body) => body.includes('mode=standalone'))).toHaveLength(1);
    expect(bodies.filter((body) => body.includes('mode=gui'))).toHaveLength(1);
  });

  it('awaits the durable mutation-action intake in every handler', () => {
    for (const body of headlessRunHandlerBodies(mainSource)) {
      expect(body).toMatch(/await \w*[mM]utationActions\.executeHeadlessRun\(\{ planPath \}\)/);
      expect(body).toContain('acceptHeadlessRunAck(');
    }
  });

  it('resolves no intake workflow id by diffing a workflow-id snapshot', () => {
    expect(mainSource).not.toMatch(/getWorkflowIds\(\)\.find\(/);
  });
});
