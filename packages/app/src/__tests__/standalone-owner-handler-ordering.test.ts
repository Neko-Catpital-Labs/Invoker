import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { buildStandaloneHeadlessExecAcknowledgement } from '../ipc/gui-mutation-handlers.js';

const MAIN = path.resolve(__dirname, '..', 'main.ts');

describe('standalone owner handler ordering', () => {
  it('registers owner discovery and exec handlers before starting launch-dispatch polling', () => {
    const source = readFileSync(MAIN, 'utf8');

    const ownerPingIdx = source.indexOf("messageBus.onRequest('headless.owner-ping'");
    const execIdx = source.indexOf("messageBus.onRequest('headless.exec'");
    const dispatcherIdx = source.indexOf('startStandaloneLaunchDispatcher({');

    expect(ownerPingIdx, 'standalone headless.owner-ping handler not found').toBeGreaterThan(-1);
    expect(execIdx, 'standalone headless.exec handler not found').toBeGreaterThan(-1);
    expect(dispatcherIdx, 'startStandaloneLaunchDispatcher call not found').toBeGreaterThan(-1);

    expect(
      ownerPingIdx,
      'INV-192: startStandaloneLaunchDispatcher must run after headless.owner-ping is registered',
    ).toBeLessThan(dispatcherIdx);
    expect(
      execIdx,
      'INV-192: startStandaloneLaunchDispatcher must run after headless.exec is registered',
    ).toBeLessThan(dispatcherIdx);
  });

  it('standalone headless.exec merges runHeadless return into the message-bus ack when unscoped', () => {
    const source = readFileSync(MAIN, 'utf8');
    const execIdx = source.indexOf("messageBus.onRequest('headless.exec'");
    const nextHandler = source.indexOf("messageBus.onRequest('headless.gui-mutation'");
    expect(execIdx, 'standalone headless.exec handler not found').toBeGreaterThan(-1);
    expect(nextHandler, 'headless.gui-mutation handler not found after headless.exec').toBeGreaterThan(execIdx);

    const handler = source.slice(execIdx, nextHandler);
    expect(handler).toMatch(/commandResult = await runHeadless/);
    expect(handler).toMatch(/if \(!workflowId\)/);
    expect(handler).toMatch(/\.\.\.\(commandResult && typeof commandResult === 'object'/);
  });

  it('merges the runHeadless return into the unscoped message-bus ack', () => {
    const commandResult = { inserted: true, row: { id: 'task-1' } };

    expect(buildStandaloneHeadlessExecAcknowledgement(undefined, commandResult)).toEqual({
      ok: true,
      inserted: true,
      row: { id: 'task-1' },
    });
  });

  it('keeps the workflow-scoped ack as { ok: true } even when runHeadless returned data', () => {
    const commandResult = { inserted: true, row: { id: 'task-1' } };

    expect(buildStandaloneHeadlessExecAcknowledgement('workflow-123', commandResult)).toEqual({ ok: true });
  });
});
