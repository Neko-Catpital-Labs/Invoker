import { afterEach, describe, expect, it, vi } from 'vitest';

import { SQLiteAdapter, type Workflow, type WorkflowMutationPriority } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import {
  createWorkflowResumeCooldownLedger,
  createWorkflowResumeTick,
  WORKFLOW_RESUME_COMMAND_CHANNEL,
} from '../workers/workflow-resume-worker.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
};

const POLL_CTX = {
  identity: { kind: 'workflow-resume', instanceId: 'w1' },
  reason: 'poll' as const,
  tickNumber: 1,
  signal: new AbortController().signal,
};

function makeWorkflow(id: string): Workflow {
  return {
    id,
    name: id,
    status: 'running',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

function makeTask(workflowId: string, taskId: string): TaskState {
  return {
    id: taskId,
    description: taskId,
    status: 'pending',
    dependencies: [],
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    config: { workflowId },
    execution: {},
    taskStateVersion: 1,
  };
}

describe('workflow resume FK regression', () => {
  let adapter: SQLiteAdapter | undefined;

  afterEach(() => {
    adapter?.close();
    adapter = undefined;
  });

  it('persists recovery.worker.submit keyed by a real task id', async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    adapter.saveWorkflow(makeWorkflow('wf-1'));
    adapter.saveTask('wf-1', makeTask('wf-1', 'wf-1/t1'));
    adapter.saveWorkflow(makeWorkflow('wf-2'));
    adapter.saveTask('wf-2', makeTask('wf-2', 'wf-2/t1'));

    const submit = vi.fn((
      workflowId: string,
      priority: WorkflowMutationPriority,
      channel: string,
      args: unknown[],
    ) => {
      expect(priority).toBe('normal');
      expect(channel).toBe(WORKFLOW_RESUME_COMMAND_CHANNEL);
      expect(args).toEqual([{}]);
      return workflowId === 'wf-1' ? 1 : 2;
    });
    const tick = createWorkflowResumeTick({
      store: adapter,
      submitter: { submit },
      logger,
      ledger: createWorkflowResumeCooldownLedger(),
      now: () => 0,
    });

    await expect(tick(POLL_CTX)).resolves.toBeUndefined();

    expect(submit.mock.calls.map(([workflowId]) => workflowId)).toEqual(['wf-1', 'wf-2']);
    expect(adapter.getEvents('wf-1/t1').map((event) => event.eventType)).toEqual([
      'recovery.worker.submit',
    ]);
    expect(adapter.getEvents('wf-2/t1').map((event) => event.eventType)).toEqual([
      'recovery.worker.submit',
    ]);
    expect(adapter.getEvents('wf-1')).toEqual([]);
    expect(adapter.getEvents('wf-2')).toEqual([]);
  });
});
