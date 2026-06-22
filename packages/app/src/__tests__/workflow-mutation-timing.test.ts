import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import { createWorkflowMutationTiming } from '../workflow-mutation-timing.js';

describe('createWorkflowMutationTiming', () => {
  const adapters: SQLiteAdapter[] = [];

  afterEach(() => {
    for (const adapter of adapters.splice(0)) {
      adapter.close();
    }
  });

  it('persists timing events on the workflow merge gate', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    const now = new Date();
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: now.toISOString(),
    updatedAt: now.toISOString(), });
    adapter.saveTask('wf-1', {
      id: '__merge__wf-1',
      description: 'merge',
      status: 'pending',
      dependencies: [],
      createdAt: now,
      config: { workflowId: 'wf-1', isMergeNode: true, runnerKind: 'merge' },
      execution: {},
      taskStateVersion: 1,
    });

    const timing = createWorkflowMutationTiming({
      persistence: adapter,
      workflowId: 'wf-1',
      channel: 'headless.exec',
      intentId: 12,
      args: [{ traceId: 'trace-1' }],
    });

    timing.mark('test.mark', 'queued', { priority: 'high' });
    await timing.span('test.span', { count: 1 }, async () => undefined);

    const events = adapter.getEvents('__merge__wf-1')
      .filter((event) => event.eventType === 'workflow.mutation.timing');
    expect(events).toHaveLength(3);
    const payloads = events.map((event) => JSON.parse(event.payload ?? '{}'));
    expect(payloads[0]).toMatchObject({
      workflowId: 'wf-1',
      channel: 'headless.exec',
      intentId: 12,
      traceId: 'trace-1',
      function: 'test.mark',
      phase: 'queued',
      priority: 'high',
    });
    expect(payloads[1]).toMatchObject({
      function: 'test.span',
      phase: 'started',
      count: 1,
    });
    expect(payloads[2]).toMatchObject({
      function: 'test.span',
      phase: 'completed',
      count: 1,
    });
    expect(typeof payloads[2].durationMs).toBe('number');
  });
});
