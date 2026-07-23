import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCommandHandler } from '../command-handler.js';
import { InvokerDownError, type InvokerClient } from '../invoker-client.js';

const noop = (): void => {};

function makeClient(overrides: Partial<InvokerClient> = {}): InvokerClient {
  const base: InvokerClient = {
    ping: vi.fn(async () => true),
    isHealthy: vi.fn(async () => true),
    listWorkflows: vi.fn(async () => []),
    getWorkflowBundle: vi.fn(async () => ({ workflow: undefined, tasks: [] })),
    getWorkflowStatus: vi.fn(async () => ({ total: 0, completed: 0, failed: 0, closed: 0, running: 0, pending: 0 })),
    getTaskOutput: vi.fn(async () => ''),
    exec: vi.fn(async () => {}),
    run: vi.fn(async () => 'wf-x'),
    launch: vi.fn(async () => true),
    withRecovery: vi.fn(async (fn: () => Promise<unknown>) => fn()) as InvokerClient['withRecovery'],
    subscribe: vi.fn(() => () => {}),
    onReconnect: vi.fn(() => () => {}),
    disconnect: vi.fn(),
  };
  return { ...base, ...overrides };
}

describe('createCommandHandler', () => {
  let plansDir: string;
  const slack = { handleEvent: vi.fn(async () => {}) };

  beforeEach(() => {
    vi.clearAllMocks();
    plansDir = mkdtempSync(path.join(tmpdir(), 'slack-mgr-plans-'));
  });

  it('approve → headless approve', async () => {
    const client = makeClient();
    await createCommandHandler({ client, slack, plansDir, log: noop })({ type: 'approve', taskId: 't1' });
    expect(client.exec).toHaveBeenCalledWith(['approve', 't1']);
  });

  it('reject carries the reason when present, omits it otherwise', async () => {
    const client = makeClient();
    const handler = createCommandHandler({ client, slack, plansDir, log: noop });
    await handler({ type: 'reject', taskId: 't1', reason: 'no good' });
    expect(client.exec).toHaveBeenCalledWith(['reject', 't1', 'no good']);
    await handler({ type: 'reject', taskId: 't2' });
    expect(client.exec).toHaveBeenCalledWith(['reject', 't2']);
  });

  it('provide_input → input, select_experiment → select, retry → retry-task', async () => {
    const client = makeClient();
    const handler = createCommandHandler({ client, slack, plansDir, log: noop });
    await handler({ type: 'provide_input', taskId: 't1', input: 'hello' });
    expect(client.exec).toHaveBeenCalledWith(['input', 't1', 'hello']);
    await handler({ type: 'select_experiment', taskId: 't1', experimentId: 'exp-a' });
    expect(client.exec).toHaveBeenCalledWith(['select', 't1', 'exp-a']);
    await handler({ type: 'retry', taskId: 't1' });
    expect(client.exec).toHaveBeenCalledWith(['retry-task', 't1']);
  });

  it('get_status → queries status and emits a workflow_status event', async () => {
    const status = { total: 2, completed: 1, failed: 0, closed: 0, running: 1, pending: 0 };
    const client = makeClient({ getWorkflowStatus: vi.fn(async () => status) });
    await createCommandHandler({ client, slack, plansDir, log: noop })({ type: 'get_status', workflowId: 'wf-1' });
    expect(client.getWorkflowStatus).toHaveBeenCalledWith('wf-1');
    expect(slack.handleEvent).toHaveBeenCalledWith({ type: 'workflow_status', status, workflowId: 'wf-1' });
  });

  it('start_plan → writes plan file, runs it, emits workflow_created', async () => {
    const client = makeClient({ run: vi.fn(async () => 'wf-new') });
    await createCommandHandler({ client, slack, plansDir, log: noop })({
      type: 'start_plan',
      planText: 'name: Demo\n',
      requestedBy: 'U1',
      lobbyChannel: 'C1',
      lobbyThreadTs: '123.45',
      harnessPreset: 'cursor+claude',
      repoUrl: 'git@example:repo.git',
    });

    const files = readdirSync(plansDir);
    expect(files).toHaveLength(1);
    const planPath = path.join(plansDir, files[0]);
    expect(readFileSync(planPath, 'utf8')).toBe('name: Demo\n');
    expect(client.run).toHaveBeenCalledWith(planPath);
    expect(slack.handleEvent).toHaveBeenCalledWith({
      type: 'workflow_created',
      workflowId: 'wf-new',
      requestedBy: 'U1',
      lobbyChannel: 'C1',
      lobbyThreadTs: '123.45',
      harnessPreset: 'cursor+claude',
      repoUrl: 'git@example:repo.git',
      planFile: planPath,
    });
  });

  it('rethrows a SlackCommandError when Invoker stays down so the surface can reply in-thread', async () => {
    const client = makeClient({ withRecovery: vi.fn(async () => { throw new InvokerDownError('down'); }) as InvokerClient['withRecovery'] });
    await expect(
      createCommandHandler({ client, slack, plansDir, log: noop })({ type: 'approve', taskId: 't1' }),
    ).rejects.toThrow(/Invoker is down/);
    expect(slack.handleEvent).not.toHaveBeenCalled();
  });
});
