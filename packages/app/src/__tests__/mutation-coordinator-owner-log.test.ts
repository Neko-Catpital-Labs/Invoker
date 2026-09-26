import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from '@invoker/contracts';
import { SQLiteAdapter } from '@invoker/data-store';

import { PersistedWorkflowMutationCoordinator } from '../persisted-workflow-mutation-coordinator.js';

type Rec = { level: string; msg: string; fields?: Record<string, unknown> };

function makeLogger(records: Rec[]): Logger {
  const push = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    records.push({ level, msg, fields });
  };
  const logger = { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error'), child: () => logger };
  return logger as unknown as Logger;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

const adapters: SQLiteAdapter[] = [];
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.close();
});

async function makeAdapter(): Promise<SQLiteAdapter> {
  const adapter = await SQLiteAdapter.create(':memory:');
  adapters.push(adapter);
  adapter.saveWorkflow({ id: 'wf-1', name: 'wf-1', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  return adapter;
}

describe('workflow mutation coordinator owner log', () => {
  it('records evicted and invalidated intents in the owner log, not only stderr', async () => {
    const adapter = await makeAdapter();
    const records: Rec[] = [];
    const gate = deferred();
    const coordinator = new PersistedWorkflowMutationCoordinator(
      adapter,
      'owner-1',
      async (_channel, args) => {
        const payload = args[0] as { args?: string[] } | undefined;
        if (payload?.args?.join(' ').includes('hold-work')) await gate.promise;
      },
      { logger: makeLogger(records) },
    );

    const running = coordinator.enqueue<void>('wf-1', 'normal', 'headless.exec', [{ args: ['set', 'command', 'wf-1/task-0', 'hold-work'] }]);
    void running.catch(() => {});
    const olderQueued = coordinator.enqueue<void>('wf-1', 'normal', 'headless.exec', [{ args: ['set', 'agent', 'wf-1/task-1', 'codex'] }]);
    void olderQueued.catch(() => {});
    await coordinator.enqueue<void>('wf-1', 'high', 'headless.exec', [{ args: ['recreate', 'wf-1'] }]);
    gate.resolve();

    const messages = records.filter((r) => r.level === 'warn').map((r) => r.msg);
    expect(messages.some((m) => m.includes('evicted') && m.includes('wf-1'))).toBe(true);
    expect(messages.some((m) => m.includes('invalidated running intent') && m.includes('wf-1'))).toBe(true);
  });

  it('records when a drain skips because another owner holds the workflow lease', async () => {
    const adapter = await makeAdapter();
    expect(adapter.claimWorkflowMutationLease('wf-1', 'other-owner')).toBe(true);
    const records: Rec[] = [];
    const coordinator = new PersistedWorkflowMutationCoordinator(
      adapter,
      'owner-1',
      async () => undefined,
      { logger: makeLogger(records) },
    );

    const pending = coordinator.enqueue<void>('wf-1', 'normal', 'headless.exec', [{ args: ['set', 'agent', 'wf-1/task-1', 'codex'] }]);
    void pending.catch(() => {});
    await new Promise((r) => setTimeout(r, 50));

    const skip = records.find((r) => r.msg.includes('lease held elsewhere'));
    expect(skip).toBeDefined();
    expect(skip!.fields).toMatchObject({ workflowId: 'wf-1', ownerId: 'owner-1' });
  });
});
