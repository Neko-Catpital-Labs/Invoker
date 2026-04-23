/**
 * Integration tests for the HTTP API server.
 *
 * Starts a real HTTP server on an ephemeral port with fully mocked deps.
 * Uses Node's built-in http module to send requests and assert responses.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { startApiServer, type ApiServer } from '../api-server.js';

// ── Helpers ──────────────────────────────────────────────────

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    status: 'running' as const,
    description: 'test task',
    dependencies: [],
    createdAt: new Date('2024-01-01T00:00:00Z'),
    config: { workflowId: 'wf-1' },
    execution: {},
    ...overrides,
  };
}

function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed: any;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode!, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Setup ────────────────────────────────────────────────────

let api: ApiServer;
let port: number;
let mocks: {
  orchestrator: Record<string, ReturnType<typeof vi.fn>>;
  persistence: Record<string, ReturnType<typeof vi.fn>>;
  executorRegistry: Record<string, ReturnType<typeof vi.fn>>;
  taskExecutor: Record<string, ReturnType<typeof vi.fn>>;
  cancelTask: ReturnType<typeof vi.fn>;
  cancelWorkflow: ReturnType<typeof vi.fn>;
  killRunningTask: ReturnType<typeof vi.fn>;
};

function createMocks() {
  return {
    orchestrator: {
      getWorkflowStatus: vi.fn(() => ({ total: 1, completed: 0, failed: 0, running: 1, pending: 0 })),
      getAllTasks: vi.fn(() => [makeTask()]),
      startExecution: vi.fn(() => []),
      getTask: vi.fn((id: string) => (id === 'task-1' ? makeTask() : undefined)),
      approve: vi.fn().mockResolvedValue([]),
      reject: vi.fn(),
      revertConflictResolution: vi.fn(),
      provideInput: vi.fn(),
      beginConflictResolution: vi.fn(() => ({ savedError: 'saved-error' })),
      setFixAwaitingApproval: vi.fn(),
      restartTask: vi.fn(() => [makeTask()]),
      editTaskCommand: vi.fn(() => [makeTask()]),
      editTaskPrompt: vi.fn(() => [makeTask()]),
      editTaskType: vi.fn(() => [makeTask()]),
      editTaskAgent: vi.fn(() => [makeTask()]),
      setTaskExternalGatePolicies: vi.fn(() => [makeTask()]),
      cancelTask: vi.fn(() => ({ cancelled: ['task-1'], runningCancelled: ['task-1'] })),
      deleteWorkflow: vi.fn(),
      getQueueStatus: vi.fn(() => ({
        maxConcurrency: 4,
        runningCount: 1,
        running: [{ taskId: 'task-1', description: 'test' }],
        queued: [],
      })),
    },
    persistence: {
      listWorkflows: vi.fn(() => [{ id: 'wf-1', name: 'test', generation: 1 }]),
      loadWorkflow: vi.fn(() => ({ id: 'wf-1', generation: 1 })),
      updateWorkflow: vi.fn(),
      loadTasks: vi.fn(() => []),
      getEvents: vi.fn(() => [{ taskId: 'task-1', eventType: 'started', timestamp: '2024-01-01' }]),
      getTaskOutput: vi.fn(() => 'hello world output'),
    },
    executorRegistry: {},
    taskExecutor: {
      executeTasks: vi.fn().mockResolvedValue(undefined),
      publishAfterFix: vi.fn().mockResolvedValue(undefined),
      resolveConflict: vi.fn().mockResolvedValue(undefined),
      fixWithAgent: vi.fn().mockResolvedValue(undefined),
      commitApprovedFix: vi.fn().mockResolvedValue(undefined),
    },
    cancelTask: vi.fn().mockResolvedValue({ cancelled: ['task-1'], runningCancelled: ['task-1'] }),
    cancelWorkflow: vi.fn().mockResolvedValue({ cancelled: ['task-1'], runningCancelled: ['task-1'] }),
    killRunningTask: vi.fn().mockResolvedValue(undefined),
  };
}

beforeAll(async () => {
  mocks = createMocks();
  // Use port 0 for ephemeral port assignment
  process.env.INVOKER_API_PORT = '0';
  api = startApiServer({
    orchestrator: mocks.orchestrator as any,
    persistence: mocks.persistence as any,
    executorRegistry: mocks.executorRegistry as any,
    taskExecutor: mocks.taskExecutor as any,
    cancelTask: mocks.cancelTask,
    cancelWorkflow: mocks.cancelWorkflow,
    killRunningTask: mocks.killRunningTask,
  });
  // Wait for the server to start listening
  await new Promise<void>((resolve) => {
    if (api.server.listening) {
      resolve();
    } else {
      api.server.on('listening', resolve);
    }
  });
  const addr = api.server.address();
  port = typeof addr === 'object' && addr ? addr.port : api.port;
});

afterAll(async () => {
  await api.close();
  delete process.env.INVOKER_API_PORT;
});

beforeEach(() => {
  // Reset all mocks between tests
  for (const group of [mocks.orchestrator, mocks.persistence, mocks.taskExecutor]) {
    for (const fn of Object.values(group)) {
      if (typeof fn === 'function' && 'mockClear' in fn) fn.mockClear();
    }
  }
  mocks.cancelTask.mockClear();
  mocks.cancelWorkflow.mockClear();
  mocks.killRunningTask.mockClear();

  // Re-apply default return values after clear
  mocks.orchestrator.getWorkflowStatus.mockReturnValue({ total: 1, completed: 0, failed: 0, running: 1, pending: 0 });
  mocks.orchestrator.getAllTasks.mockReturnValue([makeTask()]);
  mocks.orchestrator.startExecution.mockReturnValue([]);
  mocks.orchestrator.getTask.mockImplementation((id: string) => (id === 'task-1' ? makeTask() : undefined));
  mocks.orchestrator.approve.mockResolvedValue([]);
  mocks.orchestrator.restartTask.mockReturnValue([makeTask()]);
  mocks.orchestrator.beginConflictResolution.mockReturnValue({ savedError: 'saved-error' });
  mocks.orchestrator.editTaskCommand.mockReturnValue([makeTask()]);
  mocks.orchestrator.editTaskPrompt.mockReturnValue([makeTask()]);
  mocks.orchestrator.editTaskType.mockReturnValue([makeTask()]);
  mocks.orchestrator.setTaskExternalGatePolicies.mockReturnValue([makeTask()]);
  mocks.orchestrator.cancelTask.mockReturnValue({ cancelled: ['task-1'], runningCancelled: ['task-1'] });
  mocks.orchestrator.getQueueStatus.mockReturnValue({
    maxConcurrency: 4, runningCount: 1,
    running: [{ taskId: 'task-1', description: 'test' }], queued: [],
  });
  mocks.persistence.listWorkflows.mockReturnValue([{ id: 'wf-1', name: 'test', generation: 1 }]);
  mocks.persistence.loadWorkflow.mockReturnValue({ id: 'wf-1', generation: 1 });
  mocks.persistence.loadTasks.mockReturnValue([]);
  mocks.persistence.getEvents.mockReturnValue([{ taskId: 'task-1', eventType: 'started', timestamp: '2024-01-01' }]);
  mocks.persistence.getTaskOutput.mockReturnValue('hello world output');
  mocks.cancelTask.mockResolvedValue({ cancelled: ['task-1'], runningCancelled: ['task-1'] });
  mocks.cancelWorkflow.mockResolvedValue({ cancelled: ['task-1'], runningCancelled: ['task-1'] });
  mocks.killRunningTask.mockResolvedValue(undefined);
  mocks.taskExecutor.executeTasks.mockResolvedValue(undefined);
  mocks.taskExecutor.publishAfterFix.mockResolvedValue(undefined);
  mocks.taskExecutor.resolveConflict.mockResolvedValue(undefined);
  mocks.taskExecutor.fixWithAgent.mockResolvedValue(undefined);
  mocks.taskExecutor.commitApprovedFix.mockResolvedValue(undefined);
});

// ── Read endpoints ───────────────────────────────────────────

describe('GET /api/health', () => {
  it('returns 200 with ok and uptime', async () => {
    const res = await request(port, 'GET', '/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.uptime).toBe('number');
  });
});

describe('GET /api/status', () => {
  it('returns orchestrator workflow status', async () => {
    const res = await request(port, 'GET', '/api/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 1, completed: 0, failed: 0, running: 1, pending: 0 });
    expect(mocks.orchestrator.getWorkflowStatus).toHaveBeenCalled();
  });
});

describe('GET /api/tasks', () => {
  it('returns all tasks', async () => {
    const res = await request(port, 'GET', '/api/tasks');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('task-1');
  });

  it('filters by status query param', async () => {
    mocks.orchestrator.getAllTasks.mockReturnValue([
      makeTask({ id: 'task-1', status: 'running' }),
      makeTask({ id: 'task-2', status: 'completed' }),
    ]);

    const res = await request(port, 'GET', '/api/tasks?status=running');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('task-1');
  });
});

describe('GET /api/tasks/:id', () => {
  it('returns task when found', async () => {
    const res = await request(port, 'GET', '/api/tasks/task-1');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('task-1');
  });

  it('returns 404 when task not found', async () => {
    const res = await request(port, 'GET', '/api/tasks/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not found');
  });
});

describe('GET /api/workflows', () => {
  it('returns workflow list', async () => {
    const res = await request(port, 'GET', '/api/workflows');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('wf-1');
    expect(mocks.persistence.listWorkflows).toHaveBeenCalled();
  });
});

describe('GET /api/queue', () => {
  it('returns queue status', async () => {
    const res = await request(port, 'GET', '/api/queue');
    expect(res.status).toBe(200);
    expect(res.body.maxConcurrency).toBe(4);
    expect(res.body.running).toHaveLength(1);
    expect(mocks.orchestrator.getQueueStatus).toHaveBeenCalled();
  });
});

describe('GET /api/tasks/:id/events', () => {
  it('returns event log', async () => {
    const res = await request(port, 'GET', '/api/tasks/task-1/events');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].eventType).toBe('started');
    expect(mocks.persistence.getEvents).toHaveBeenCalledWith('task-1');
  });
});

describe('GET /api/tasks/:id/output', () => {
  it('returns task output', async () => {
    const res = await request(port, 'GET', '/api/tasks/task-1/output');
    expect(res.status).toBe(200);
    expect(res.body.taskId).toBe('task-1');
    expect(res.body.output).toBe('hello world output');
    expect(mocks.persistence.getTaskOutput).toHaveBeenCalledWith('task-1');
  });
});

// ── Write endpoints ──────────────────────────────────────────

describe('POST /api/tasks/:id/cancel', () => {
  it('cancels task via cancelTask callback', async () => {
    const res = await request(port, 'POST', '/api/tasks/task-1/cancel');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mocks.cancelTask).toHaveBeenCalledWith('task-1');
    expect(mocks.orchestrator.startExecution).toHaveBeenCalled();
  });

  it('falls back to orchestrator.cancelTask when callback not provided', async () => {
    // Create a server without cancelTask callback
    const noCancelMocks = createMocks();
    const noCancelApi = startApiServer({
      orchestrator: noCancelMocks.orchestrator as any,
      persistence: noCancelMocks.persistence as any,
      executorRegistry: noCancelMocks.executorRegistry as any,
      taskExecutor: noCancelMocks.taskExecutor as any,
      killRunningTask: noCancelMocks.killRunningTask,
      // no cancelTask
    });
    await new Promise<void>((resolve) => {
      if (noCancelApi.server.listening) resolve();
      else noCancelApi.server.on('listening', resolve);
    });
    const noCancelPort = (noCancelApi.server.address() as any).port;

    try {
      const res = await request(noCancelPort, 'POST', '/api/tasks/task-1/cancel');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(noCancelMocks.orchestrator.cancelTask).toHaveBeenCalledWith('task-1');
      expect(noCancelMocks.orchestrator.startExecution).toHaveBeenCalled();
    } finally {
      await noCancelApi.close();
    }
  });
});

describe('POST /api/workflows/:id/cancel', () => {
  it('cancels workflow via cancelWorkflow callback', async () => {
    const res = await request(port, 'POST', '/api/workflows/wf-1/cancel');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mocks.cancelWorkflow).toHaveBeenCalledWith('wf-1');
    expect(mocks.orchestrator.startExecution).toHaveBeenCalled();
  });

  it('falls back to shared cancelWorkflow when callback not provided', async () => {
    const noCancelMocks = createMocks();
    noCancelMocks.orchestrator.cancelWorkflow = vi.fn(() => ({
      cancelled: ['task-1'],
      runningCancelled: ['task-1'],
    }));
    const noCancelApi = startApiServer({
      orchestrator: noCancelMocks.orchestrator as any,
      persistence: noCancelMocks.persistence as any,
      executorRegistry: noCancelMocks.executorRegistry as any,
      taskExecutor: noCancelMocks.taskExecutor as any,
      killRunningTask: noCancelMocks.killRunningTask,
      // no cancelWorkflow
    });
    await new Promise<void>((resolve) => {
      if (noCancelApi.server.listening) resolve();
      else noCancelApi.server.on('listening', resolve);
    });
    const noCancelPort = (noCancelApi.server.address() as any).port;

    try {
      const res = await request(noCancelPort, 'POST', '/api/workflows/wf-1/cancel');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(noCancelMocks.orchestrator.cancelWorkflow).toHaveBeenCalledWith('wf-1');
      expect(noCancelMocks.orchestrator.startExecution).toHaveBeenCalled();
    } finally {
      await noCancelApi.close();
    }
  });
});

describe('POST /api/tasks/:id/restart', () => {
  it('restarts task via shared restartTask', async () => {
    const res = await request(port, 'POST', '/api/tasks/task-1/restart');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.action).toBe('restarted');
    expect(mocks.orchestrator.restartTask).toHaveBeenCalledWith('task-1');
    expect(mocks.killRunningTask).toHaveBeenCalledWith('task-1');
  });

  it('returns 400 on error', async () => {
    mocks.orchestrator.restartTask.mockImplementation(() => {
      throw new Error('task not restartable');
    });
    const res = await request(port, 'POST', '/api/tasks/task-1/restart');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('task not restartable');
  });

  it('tops up globally ready tasks after scoped restart launch', async () => {
    const scoped = makeTask({
      id: 'task-1',
      status: 'running',
      execution: { selectedAttemptId: 'attempt-1' },
    });
    const topup = makeTask({
      id: 'wf-2/task-9',
      config: { workflowId: 'wf-2' },
      status: 'running',
      execution: { selectedAttemptId: 'attempt-9' },
    });
    mocks.orchestrator.restartTask.mockReturnValue([scoped]);
    mocks.orchestrator.startExecution.mockReturnValue([topup]);

    const res = await request(port, 'POST', '/api/tasks/task-1/restart');
    expect(res.status).toBe(200);
    expect(mocks.taskExecutor.executeTasks).toHaveBeenCalledTimes(2);
    expect(mocks.taskExecutor.executeTasks).toHaveBeenNthCalledWith(1, [scoped]);
    expect(mocks.taskExecutor.executeTasks).toHaveBeenNthCalledWith(2, [topup]);
  });

  it('does not relaunch duplicate attempt from global top-up', async () => {
    const scoped = makeTask({
      id: 'task-1',
      status: 'running',
      execution: { selectedAttemptId: 'attempt-1' },
    });
    const duplicate = makeTask({
      id: 'task-1',
      status: 'running',
      execution: { selectedAttemptId: 'attempt-1' },
    });
    mocks.orchestrator.restartTask.mockReturnValue([scoped]);
    mocks.orchestrator.startExecution.mockReturnValue([duplicate]);

    const res = await request(port, 'POST', '/api/tasks/task-1/restart');
    expect(res.status).toBe(200);
    expect(mocks.taskExecutor.executeTasks).toHaveBeenCalledTimes(1);
    expect(mocks.taskExecutor.executeTasks).toHaveBeenCalledWith([scoped]);
  });
});

describe('POST /api/tasks/:id/approve', () => {
  it('approves task', async () => {
    const res = await request(port, 'POST', '/api/tasks/task-1/approve');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.action).toBe('approved');
    expect(mocks.orchestrator.approve).toHaveBeenCalledWith('task-1');
    expect(mocks.orchestrator.startExecution).toHaveBeenCalled();
  });

  it('routes downstream merge nodes to executeTasks (not publishAfterFix)', async () => {
    mocks.orchestrator.approve.mockResolvedValue([
      makeTask({ id: 'merge-1', status: 'running', config: { isMergeNode: true } }),
      makeTask({ id: 'task-2', status: 'running', config: {} }),
    ]);

    const res = await request(port, 'POST', '/api/tasks/task-1/approve');
    expect(res.status).toBe(200);
    expect(mocks.taskExecutor.publishAfterFix).not.toHaveBeenCalled();
    expect(mocks.taskExecutor.executeTasks).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: 'merge-1' }),
        expect.objectContaining({ id: 'task-2' }),
      ]),
    );
  });

  it('routes post-fix merge nodes to publishAfterFix', async () => {
    mocks.orchestrator.approve.mockResolvedValue([
      makeTask({ id: 'task-1', status: 'running', config: { isMergeNode: true } }),
    ]);

    const res = await request(port, 'POST', '/api/tasks/task-1/approve');
    expect(res.status).toBe(200);
    expect(mocks.taskExecutor.publishAfterFix).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-1' }),
    );
  });

  it('returns 400 on error', async () => {
    mocks.orchestrator.approve.mockRejectedValue(new Error('not awaiting approval'));
    const res = await request(port, 'POST', '/api/tasks/task-1/approve');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('not awaiting approval');
  });

  it('uses approveTaskAction when provided', async () => {
    const approveTaskAction = vi.fn().mockResolvedValue({ started: [] });
    const isolatedApi = startApiServer({
      orchestrator: mocks.orchestrator as any,
      persistence: mocks.persistence as any,
      executorRegistry: mocks.executorRegistry as any,
      taskExecutor: mocks.taskExecutor as any,
      approveTaskAction,
      cancelTask: mocks.cancelTask,
      cancelWorkflow: mocks.cancelWorkflow,
      killRunningTask: mocks.killRunningTask,
    });
    await new Promise<void>((resolve) => {
      if (isolatedApi.server.listening) {
        resolve();
      } else {
        isolatedApi.server.on('listening', resolve);
      }
    });
    const addr = isolatedApi.server.address();
    const isolatedPort = typeof addr === 'object' && addr ? addr.port : isolatedApi.port;

    try {
      const res = await request(isolatedPort, 'POST', '/api/tasks/task-1/approve');
      expect(res.status).toBe(200);
      expect(approveTaskAction).toHaveBeenCalledWith('task-1');
      expect(mocks.orchestrator.approve).not.toHaveBeenCalled();
    } finally {
      await isolatedApi.close();
    }
  });
});

describe('POST /api/tasks/:id/resolve-conflict', () => {
  it('tops up globally ready work after resolve-conflict', async () => {
    const res = await request(port, 'POST', '/api/tasks/task-1/resolve-conflict', { agent: 'claude' });
    expect(res.status).toBe(200);
    expect(mocks.orchestrator.startExecution).toHaveBeenCalled();
  });
});

describe('POST /api/tasks/:id/reject', () => {
  it('rejects task without reason', async () => {
    const res = await request(port, 'POST', '/api/tasks/task-1/reject');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.action).toBe('rejected');
    expect(mocks.orchestrator.reject).toHaveBeenCalledWith('task-1', undefined);
  });

  it('rejects task with reason', async () => {
    const res = await request(port, 'POST', '/api/tasks/task-1/reject', { reason: 'wrong output' });
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe('wrong output');
    expect(mocks.orchestrator.reject).toHaveBeenCalledWith('task-1', 'wrong output');
  });

  it('reverts conflict resolution when pendingFixError exists', async () => {
    mocks.orchestrator.getTask.mockReturnValue(
      makeTask({ execution: { pendingFixError: 'merge conflict' } }),
    );
    const res = await request(port, 'POST', '/api/tasks/task-1/reject');
    expect(res.status).toBe(200);
    expect(mocks.orchestrator.revertConflictResolution).toHaveBeenCalledWith('task-1', 'merge conflict');
    expect(mocks.orchestrator.reject).not.toHaveBeenCalled();
  });
});

describe('POST /api/tasks/:id/input', () => {
  it('provides input to task', async () => {
    const res = await request(port, 'POST', '/api/tasks/task-1/input', { text: 'yes' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.action).toBe('input_provided');
    expect(mocks.orchestrator.provideInput).toHaveBeenCalledWith('task-1', 'yes');
  });

  it('returns 400 when text is missing', async () => {
    const res = await request(port, 'POST', '/api/tasks/task-1/input', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing "text"');
  });
});

describe('POST /api/tasks/:id/edit', () => {
  it('edits task command', async () => {
    const res = await request(port, 'POST', '/api/tasks/task-1/edit', { command: 'npm test' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.action).toBe('command_edited');
    expect(mocks.orchestrator.editTaskCommand).toHaveBeenCalledWith('task-1', 'npm test');
  });

  it('returns 400 when command is missing', async () => {
    const res = await request(port, 'POST', '/api/tasks/task-1/edit', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing "command"');
  });
});

describe('POST /api/tasks/:id/edit-prompt', () => {
  it('edits task prompt and routes through orchestrator.editTaskPrompt', async () => {
    const res = await request(port, 'POST', '/api/tasks/task-1/edit-prompt', { prompt: 'do the thing' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.action).toBe('prompt_edited');
    expect(mocks.orchestrator.editTaskPrompt).toHaveBeenCalledWith('task-1', 'do the thing');
    expect(mocks.orchestrator.editTaskCommand).not.toHaveBeenCalled();
    // Endpoint dispatches any newly-runnable tasks via the executor.
    expect(mocks.taskExecutor.executeTasks).toHaveBeenCalled();
  });

  it('returns 400 when prompt is missing', async () => {
    const res = await request(port, 'POST', '/api/tasks/task-1/edit-prompt', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing "prompt"');
  });
});

describe('POST /api/tasks/:id/edit-type', () => {
  it('edits task type', async () => {
    const res = await request(port, 'POST', '/api/tasks/task-1/edit-type', { executorType: 'docker' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.action).toBe('type_edited');
    expect(mocks.orchestrator.editTaskType).toHaveBeenCalledWith('task-1', 'docker', undefined);
  });

  it('passes remoteTargetId when provided', async () => {
    const res = await request(port, 'POST', '/api/tasks/task-1/edit-type', {
      executorType: 'ssh',
      remoteTargetId: 'remote-1',
    });
    expect(res.status).toBe(200);
    expect(mocks.orchestrator.editTaskType).toHaveBeenCalledWith('task-1', 'ssh', 'remote-1');
  });

  it('returns 400 when executorType is missing', async () => {
    const res = await request(port, 'POST', '/api/tasks/task-1/edit-type', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing "executorType"');
  });

  it('forwards a remoteTargetId-only change (host change) so the orchestrator can take the recreate-class branch', async () => {
    const res = await request(port, 'POST', '/api/tasks/task-1/edit-type', {
      executorType: 'ssh',
      remoteTargetId: 'remote-b',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.action).toBe('type_edited');
    // Both args are forwarded — `Orchestrator.editTaskType` uses them
    // to compute the host-key and pick the recreate-class fork
    // (see `MUTATION_POLICIES.remoteTargetId` and orchestrator unit
    // coverage). No new public surface; the recreate-vs-retry choice
    // is internal.
    expect(mocks.orchestrator.editTaskType).toHaveBeenCalledWith('task-1', 'ssh', 'remote-b');
    expect(mocks.taskExecutor.executeTasks).toHaveBeenCalled();
  });
});

describe('POST /api/tasks/:id/edit-agent', () => {
  it('edits task agent and routes through orchestrator.editTaskAgent', async () => {
    const res = await request(port, 'POST', '/api/tasks/task-1/edit-agent', { agent: 'codex' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.action).toBe('agent_edited');
    expect(mocks.orchestrator.editTaskAgent).toHaveBeenCalledWith('task-1', 'codex');
    expect(mocks.orchestrator.editTaskCommand).not.toHaveBeenCalled();
    expect(mocks.orchestrator.editTaskPrompt).not.toHaveBeenCalled();
    // Endpoint dispatches any newly-runnable tasks via the executor.
    expect(mocks.taskExecutor.executeTasks).toHaveBeenCalled();
  });

  it('returns 400 when agent is missing', async () => {
    const res = await request(port, 'POST', '/api/tasks/task-1/edit-agent', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing "agent"');
  });
});

describe('POST /api/tasks/:id/gate-policy', () => {
  it('updates gate policy and executes started tasks', async () => {
    const res = await request(port, 'POST', '/api/tasks/task-1/gate-policy', {
      updates: [
        { workflowId: 'wf-upstream', taskId: '__merge__', gatePolicy: 'review_ready' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.action).toBe('gate_policy_updated');
    expect(mocks.orchestrator.setTaskExternalGatePolicies).toHaveBeenCalledWith(
      'task-1',
      [{ workflowId: 'wf-upstream', taskId: '__merge__', gatePolicy: 'review_ready' }],
    );
    expect(mocks.taskExecutor.executeTasks).toHaveBeenCalled();
  });

  it('returns 400 when updates are missing', async () => {
    const res = await request(port, 'POST', '/api/tasks/task-1/gate-policy', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing non-empty "updates" array');
  });
});

describe('POST /api/workflows/:id/restart', () => {
  it('restarts workflow via shared function', async () => {
    mocks.orchestrator.recreateWorkflow = vi.fn(() => [makeTask()]);
    const res = await request(port, 'POST', '/api/workflows/wf-1/restart');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.action).toBe('restarted');
    expect(mocks.persistence.loadWorkflow).toHaveBeenCalledWith('wf-1');
    expect(mocks.persistence.updateWorkflow).toHaveBeenCalled();
  });

  it('handles concurrent restart requests independently', async () => {
    mocks.orchestrator.recreateWorkflow = vi.fn(() => [makeTask()]);
    mocks.taskExecutor.executeTasks.mockImplementation(
      async () => await new Promise<void>((resolve) => setTimeout(resolve, 100)),
    );

    const [r1, r2] = await Promise.all([
      request(port, 'POST', '/api/workflows/wf-1/restart'),
      request(port, 'POST', '/api/workflows/wf-1/restart'),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.coalesced).toBeUndefined();
    expect(r2.body.coalesced).toBeUndefined();
    expect(mocks.persistence.updateWorkflow).toHaveBeenCalledTimes(2);
    expect(mocks.orchestrator.recreateWorkflow).toHaveBeenCalledTimes(2);
    expect(mocks.taskExecutor.executeTasks).toHaveBeenCalledTimes(2);
  });

  it('returns 400 on error', async () => {
    mocks.persistence.loadWorkflow.mockReturnValue(undefined);
    const res = await request(port, 'POST', '/api/workflows/missing/restart');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not found');
  });

  it('tops up globally ready tasks after workflow restart launch', async () => {
    const scoped = makeTask({
      id: 'wf-1/task-1',
      config: { workflowId: 'wf-1' },
      execution: { selectedAttemptId: 'attempt-wf1' },
    });
    const topup = makeTask({
      id: 'wf-2/task-1',
      config: { workflowId: 'wf-2' },
      execution: { selectedAttemptId: 'attempt-wf2' },
    });
    mocks.orchestrator.recreateWorkflow = vi.fn(() => [scoped]);
    mocks.orchestrator.startExecution.mockReturnValue([topup]);

    const res = await request(port, 'POST', '/api/workflows/wf-1/restart');
    expect(res.status).toBe(200);
    expect(mocks.taskExecutor.executeTasks).toHaveBeenCalledTimes(2);
    expect(mocks.taskExecutor.executeTasks).toHaveBeenNthCalledWith(1, [scoped]);
    expect(mocks.taskExecutor.executeTasks).toHaveBeenNthCalledWith(2, [topup]);
  });
});

describe('DELETE /api/workflows/:id', () => {
  it('deletes workflow', async () => {
    const res = await request(port, 'DELETE', '/api/workflows/wf-1');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.action).toBe('deleted');
    expect(mocks.orchestrator.deleteWorkflow).toHaveBeenCalledWith('wf-1');
  });

  it('returns 400 on error', async () => {
    mocks.orchestrator.deleteWorkflow.mockImplementation(() => {
      throw new Error('workflow not found');
    });
    const res = await request(port, 'DELETE', '/api/workflows/missing');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('workflow not found');
  });
});

describe('POST /api/workflows/:id/merge-mode', () => {
  it('sets merge mode', async () => {
    const res = await request(port, 'POST', '/api/workflows/wf-1/merge-mode', { mode: 'automatic' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.action).toBe('merge_mode_set');
    expect(res.body.mode).toBe('automatic');
    expect(mocks.persistence.updateWorkflow).toHaveBeenCalledWith('wf-1', { mergeMode: 'automatic' });
  });

  it('returns 400 when mode is missing', async () => {
    const res = await request(port, 'POST', '/api/workflows/wf-1/merge-mode', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing "mode"');
  });

  it('returns 400 on invalid mode', async () => {
    const res = await request(port, 'POST', '/api/workflows/wf-1/merge-mode', { mode: 'invalid' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid mergeMode');
  });
});

describe('Unknown routes', () => {
  it('returns 404 for unknown path', async () => {
    const res = await request(port, 'GET', '/api/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });

  it('returns 404 for wrong method on known path', async () => {
    const res = await request(port, 'DELETE', '/api/health');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });
});
