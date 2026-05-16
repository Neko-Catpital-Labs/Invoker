/**
 * Integration tests for the HTTP API server.
 *
 * Starts a real HTTP server on an ephemeral port with fully mocked deps.
 * Uses Node's built-in http module to send requests and assert responses.
 *
 * All write endpoints route through a WorkflowMutationFacade instance
 * which wraps the mocked orchestrator, persistence, and taskExecutor.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { startApiServer, type ApiServer } from '../api-server.js';
import { WorkflowMutationFacade } from '../workflow-mutation-facade.js';
import { OrchestratorError, OrchestratorErrorCode } from '@invoker/workflow-core';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

function matchCount(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

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
      retryTask: vi.fn(() => [makeTask()]),
      editTaskCommand: vi.fn(() => [makeTask()]),
      editTaskPrompt: vi.fn(() => [makeTask()]),
      editTaskType: vi.fn(() => [makeTask()]),
      editTaskAgent: vi.fn(() => [makeTask()]),
      setTaskExternalGatePolicies: vi.fn(() => [makeTask()]),
      cancelTask: vi.fn(() => ({ cancelled: ['task-1'], runningCancelled: ['task-1'] })),
      forkWorkflow: vi.fn((workflowId: string) => ({
        sourceWorkflowId: workflowId,
        forkedWorkflowId: `${workflowId}-fork`,
        started: [makeTask({ id: `${workflowId}-fork/task-1`, config: { workflowId: `${workflowId}-fork` } })],
      })),
      deleteWorkflow: vi.fn(),
      detachWorkflow: vi.fn(),
      getQueueStatus: vi.fn(() => ({
        maxConcurrency: 4,
        runningCount: 1,
        running: [{ taskId: 'task-1', description: 'test' }],
        queued: [],
      })),
      cancelWorkflow: vi.fn(() => ({
        cancelled: ['task-1'],
        runningCancelled: ['task-1'],
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
    killRunningTask: vi.fn().mockResolvedValue(undefined),
  };
}

function buildFacade(m: typeof mocks) {
  return new WorkflowMutationFacade({
    orchestrator: m.orchestrator as any,
    persistence: m.persistence as any,
    taskExecutor: m.taskExecutor as any,
    killRunningTask: m.killRunningTask,
  });
}

beforeAll(async () => {
  mocks = createMocks();
  // Use port 0 for ephemeral port assignment
  process.env.INVOKER_API_PORT = '0';
  api = startApiServer({
    orchestrator: mocks.orchestrator as any,
    persistence: mocks.persistence as any,
    executorRegistry: mocks.executorRegistry as any,
    mutations: buildFacade(mocks),
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
  mocks.killRunningTask.mockClear();

  // Re-apply default return values after clear
  mocks.orchestrator.getWorkflowStatus.mockReturnValue({ total: 1, completed: 0, failed: 0, running: 1, pending: 0 });
  mocks.orchestrator.getAllTasks.mockReturnValue([makeTask()]);
  mocks.orchestrator.startExecution.mockReturnValue([]);
  mocks.orchestrator.getTask.mockImplementation((id: string) => (id === 'task-1' ? makeTask() : undefined));
  mocks.orchestrator.approve.mockResolvedValue([]);
  mocks.orchestrator.retryTask.mockReturnValue([makeTask()]);
  mocks.orchestrator.beginConflictResolution.mockReturnValue({ savedError: 'saved-error' });
  mocks.orchestrator.editTaskCommand.mockReturnValue([makeTask()]);
  mocks.orchestrator.editTaskPrompt.mockReturnValue([makeTask()]);
  mocks.orchestrator.editTaskType.mockReturnValue([makeTask()]);
  mocks.orchestrator.setTaskExternalGatePolicies.mockReturnValue([makeTask()]);
  mocks.orchestrator.cancelTask.mockReturnValue({ cancelled: ['task-1'], runningCancelled: ['task-1'] });
  mocks.orchestrator.cancelWorkflow.mockReturnValue({ cancelled: ['task-1'], runningCancelled: ['task-1'] });
  mocks.orchestrator.getQueueStatus.mockReturnValue({
    maxConcurrency: 4, runningCount: 1,
    running: [{ taskId: 'task-1', description: 'test' }], queued: [],
  });
  mocks.persistence.listWorkflows.mockReturnValue([{ id: 'wf-1', name: 'test', generation: 1 }]);
  mocks.persistence.loadWorkflow.mockReturnValue({ id: 'wf-1', generation: 1 });
  mocks.persistence.loadTasks.mockReturnValue([]);
  mocks.persistence.getEvents.mockReturnValue([{ taskId: 'task-1', eventType: 'started', timestamp: '2024-01-01' }]);
  mocks.persistence.getTaskOutput.mockReturnValue('hello world output');
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
  it('cancels task via facade', async () => {
    const res = await request(port, 'POST', '/api/tasks/task-1/cancel');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mocks.orchestrator.cancelTask).toHaveBeenCalledWith('task-1');
    expect(mocks.orchestrator.startExecution).toHaveBeenCalled();
  });
});

describe('POST /api/workflows/:id/cancel', () => {
  it('cancels workflow via facade', async () => {
    const res = await request(port, 'POST', '/api/workflows/wf-1/cancel');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mocks.orchestrator.cancelWorkflow).toHaveBeenCalledWith('wf-1');
    expect(mocks.orchestrator.startExecution).toHaveBeenCalled();
  });
});

describe('POST /api/tasks/:id/restart', () => {
  it('restarts task via facade retryTask', async () => {
    const res = await request(port, 'POST', '/api/tasks/task-1/restart');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.action).toBe('restarted');
    expect(mocks.orchestrator.retryTask).toHaveBeenCalledWith('task-1');
  });

  it('returns 400 on error', async () => {
    mocks.orchestrator.retryTask.mockImplementation(() => {
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
    mocks.orchestrator.retryTask.mockReturnValue([scoped]);
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
    mocks.orchestrator.retryTask.mockReturnValue([scoped]);
    mocks.orchestrator.startExecution.mockReturnValue([duplicate]);

    const res = await request(port, 'POST', '/api/tasks/task-1/restart');
    expect(res.status).toBe(200);
    expect(mocks.taskExecutor.executeTasks).toHaveBeenCalledTimes(1);
    expect(mocks.taskExecutor.executeTasks).toHaveBeenCalledWith([scoped]);
  });
});

describe('POST /api/tasks/:id/approve', () => {
  it('approves task via facade', async () => {
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

  // Step 16: approve POST does not trigger retry/recreate/cancel routes
  it('Step 16: approve POST does not trigger retry/recreate/cancel routes', async () => {
    mocks.orchestrator.recreateTask = vi.fn();
    mocks.orchestrator.recreateWorkflow = vi.fn();
    mocks.orchestrator.cancelWorkflow = vi.fn();

    const res = await request(port, 'POST', '/api/tasks/task-1/approve');

    expect(res.status).toBe(200);
    expect(res.body.action).toBe('approved');
    expect(mocks.orchestrator.approve).toHaveBeenCalledTimes(1);
    expect(mocks.orchestrator.retryTask).not.toHaveBeenCalled();
    expect(mocks.orchestrator.recreateTask).not.toHaveBeenCalled();
    expect(mocks.orchestrator.recreateWorkflow).not.toHaveBeenCalled();
    expect(mocks.orchestrator.cancelTask).not.toHaveBeenCalled();
    expect(mocks.orchestrator.cancelWorkflow).not.toHaveBeenCalled();
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

  // Step 16: reject POST does not trigger retry/recreate/cancel routes (non-fix path)
  it('Step 16: reject POST does not trigger retry/recreate/cancel routes (non-fix path)', async () => {
    mocks.orchestrator.recreateTask = vi.fn();
    mocks.orchestrator.recreateWorkflow = vi.fn();
    mocks.orchestrator.cancelWorkflow = vi.fn();

    const res = await request(port, 'POST', '/api/tasks/task-1/reject');

    expect(res.status).toBe(200);
    expect(res.body.action).toBe('rejected');
    expect(mocks.orchestrator.reject).toHaveBeenCalledTimes(1);
    expect(mocks.orchestrator.retryTask).not.toHaveBeenCalled();
    expect(mocks.orchestrator.recreateTask).not.toHaveBeenCalled();
    expect(mocks.orchestrator.recreateWorkflow).not.toHaveBeenCalled();
    expect(mocks.orchestrator.cancelTask).not.toHaveBeenCalled();
    expect(mocks.orchestrator.cancelWorkflow).not.toHaveBeenCalled();
  });

  it('Step 16: reject POST does not trigger retry/recreate/cancel routes (fix-flow path)', async () => {
    mocks.orchestrator.recreateTask = vi.fn();
    mocks.orchestrator.recreateWorkflow = vi.fn();
    mocks.orchestrator.cancelWorkflow = vi.fn();
    mocks.orchestrator.getTask.mockReturnValue(
      makeTask({ execution: { pendingFixError: 'merge conflict' } }),
    );

    const res = await request(port, 'POST', '/api/tasks/task-1/reject');

    expect(res.status).toBe(200);
    expect(res.body.action).toBe('rejected');
    expect(mocks.orchestrator.revertConflictResolution).toHaveBeenCalledWith(
      'task-1',
      'merge conflict',
    );
    expect(mocks.orchestrator.reject).not.toHaveBeenCalled();
    expect(mocks.orchestrator.retryTask).not.toHaveBeenCalled();
    expect(mocks.orchestrator.recreateTask).not.toHaveBeenCalled();
    expect(mocks.orchestrator.recreateWorkflow).not.toHaveBeenCalled();
    expect(mocks.orchestrator.cancelTask).not.toHaveBeenCalled();
    expect(mocks.orchestrator.cancelWorkflow).not.toHaveBeenCalled();
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
    // Facade dispatches any newly-runnable tasks via the executor.
    expect(mocks.taskExecutor.executeTasks).toHaveBeenCalled();
  });

  it('returns 400 when prompt is missing', async () => {
    const res = await request(port, 'POST', '/api/tasks/task-1/edit-prompt', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing "prompt"');
  });

  it('only dispatches running tasks returned by editTaskPrompt', async () => {
    const running = makeTask({
      id: 'task-1',
      status: 'running',
      execution: { selectedAttemptId: 'attempt-1' },
    });
    const pending = makeTask({
      id: 'task-2',
      status: 'pending',
      execution: {},
    });
    mocks.orchestrator.editTaskPrompt.mockReturnValue([running, pending]);

    const res = await request(port, 'POST', '/api/tasks/task-1/edit-prompt', { prompt: 'new prompt' });
    expect(res.status).toBe(200);
    expect(res.body.tasksStarted).toBe(1);
    expect(mocks.taskExecutor.executeTasks).toHaveBeenCalledTimes(1);
    expect(mocks.taskExecutor.executeTasks).toHaveBeenCalledWith([running]);
  });

  it('does not call editTaskCommand when editing prompt', async () => {
    await request(port, 'POST', '/api/tasks/task-1/edit-prompt', { prompt: 'new prompt' });
    expect(mocks.orchestrator.editTaskPrompt).toHaveBeenCalledWith('task-1', 'new prompt');
    expect(mocks.orchestrator.editTaskCommand).not.toHaveBeenCalled();
  });
});

describe('POST /api/tasks/:id/edit-type', () => {
  it('edits task type', async () => {
    const res = await request(port, 'POST', '/api/tasks/task-1/edit-type', { runnerKind: 'docker' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.action).toBe('type_edited');
    expect(mocks.orchestrator.editTaskType).toHaveBeenCalledWith('task-1', 'docker', undefined);
  });

  it('passes poolMemberId when provided', async () => {
    const res = await request(port, 'POST', '/api/tasks/task-1/edit-type', {
      runnerKind: 'ssh',
      poolMemberId: 'remote-1',
    });
    expect(res.status).toBe(200);
    expect(mocks.orchestrator.editTaskType).toHaveBeenCalledWith('task-1', 'ssh', 'remote-1');
  });

  it('returns 400 when runnerKind is missing', async () => {
    const res = await request(port, 'POST', '/api/tasks/task-1/edit-type', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing "runnerKind"');
  });

  it('forwards a poolMemberId-only change (host change)', async () => {
    const res = await request(port, 'POST', '/api/tasks/task-1/edit-type', {
      runnerKind: 'ssh',
      poolMemberId: 'remote-b',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.action).toBe('type_edited');
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
    // Facade dispatches any newly-runnable tasks via the executor.
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

  // Step 15: gate-policy POST does not trigger retry/recreate routes
  it('Step 15: gate-policy POST does not trigger retry/recreate routes', async () => {
    mocks.orchestrator.recreateTask = vi.fn();
    mocks.orchestrator.recreateWorkflow = vi.fn();
    mocks.orchestrator.cancelWorkflow = vi.fn();

    const res = await request(port, 'POST', '/api/tasks/task-1/gate-policy', {
      updates: [
        { workflowId: 'wf-upstream', taskId: '__merge__', gatePolicy: 'review_ready' },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.action).toBe('gate_policy_updated');
    expect(mocks.orchestrator.setTaskExternalGatePolicies).toHaveBeenCalledTimes(1);
    expect(mocks.orchestrator.retryTask).not.toHaveBeenCalled();
    expect(mocks.orchestrator.recreateTask).not.toHaveBeenCalled();
    expect(mocks.orchestrator.recreateWorkflow).not.toHaveBeenCalled();
    expect(mocks.orchestrator.cancelTask).not.toHaveBeenCalled();
    expect(mocks.orchestrator.cancelWorkflow).not.toHaveBeenCalled();
  });
});

describe('POST /api/workflows/:id/restart', () => {
  it('restarts workflow via facade recreateWorkflow', async () => {
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

  it('returns 404 when workflow not found', async () => {
    mocks.persistence.loadWorkflow.mockReturnValue(undefined);
    const res = await request(port, 'POST', '/api/workflows/missing/restart');
    expect(res.status).toBe(404);
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

describe('POST /api/workflows/:id/rebase-and-retry', () => {
  it('normalizes merge-node targets to the owning workflow before fresh-base recreate', async () => {
    mocks.persistence.loadWorkflow = vi.fn((workflowId: string) => (
      workflowId === 'wf-1' ? { id: 'wf-1', generation: 1 } : undefined
    ));
    mocks.persistence.loadTasks = vi.fn((workflowId: string) => (
      workflowId === 'wf-1'
        ? [makeTask({ id: '__merge__wf-1', config: { workflowId: 'wf-1', isMergeNode: true } })]
        : []
    ));
    mocks.orchestrator.recreateWorkflowFromFreshBase = vi.fn(async () => [makeTask()]);

    const res = await request(port, 'POST', '/api/workflows/__merge__wf-1/rebase-and-retry');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.workflowId).toBe('wf-1');
    expect(res.body.action).toBe('rebase_and_retried');
    expect(mocks.persistence.updateWorkflow).toHaveBeenCalledWith('wf-1', expect.any(Object));
    expect(mocks.orchestrator.recreateWorkflowFromFreshBase).toHaveBeenCalledWith(
      'wf-1',
      expect.objectContaining({ refreshBase: expect.any(Function) }),
    );
  });
});

// Step 14: live-workflow topology mutations route through Orchestrator.forkWorkflow
describe('POST /api/workflows/:id/fork', () => {
  it('forks the workflow via facade and returns both ids', async () => {
    const res = await request(port, 'POST', '/api/workflows/wf-1/fork');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sourceWorkflowId).toBe('wf-1');
    expect(res.body.forkedWorkflowId).toBe('wf-1-fork');
    expect(mocks.orchestrator.forkWorkflow).toHaveBeenCalledWith('wf-1');
    expect(mocks.taskExecutor.executeTasks).toHaveBeenCalled();
  });

  it('returns an error status when forkWorkflow throws', async () => {
    mocks.orchestrator.forkWorkflow.mockImplementationOnce(() => {
      throw new OrchestratorError(OrchestratorErrorCode.WORKFLOW_NOT_FOUND, 'Workflow missing not found');
    });
    const res = await request(port, 'POST', '/api/workflows/missing/fork');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not found');
  });
});

describe('POST /api/workflows/:id/recreate-with-rebase', () => {
  it('recreates workflow from fresh base', async () => {
    mocks.orchestrator.recreateWorkflowFromFreshBase = vi.fn().mockResolvedValue([makeTask()]);
    const res = await request(port, 'POST', '/api/workflows/wf-1/recreate-with-rebase');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.action).toBe('recreated_with_rebase');
    expect(res.body.tasksStarted).toBe(1);
    expect(res.body.deprecated).toBeUndefined();
    expect(mocks.orchestrator.recreateWorkflowFromFreshBase).toHaveBeenCalledWith(
      'wf-1',
      expect.objectContaining({ refreshBase: expect.any(Function) }),
    );
  });

  it('keeps cross-workflow started tasks out of the scoped recreate-with-rebase runnable result', async () => {
    const scoped = makeTask({
      id: 'wf-1/task-a',
      config: { workflowId: 'wf-1' },
      execution: { selectedAttemptId: 'attempt-a' },
    });
    const crossWorkflow = makeTask({
      id: 'wf-2/task-b',
      config: { workflowId: 'wf-2' },
      execution: { selectedAttemptId: 'attempt-b' },
    });
    mocks.orchestrator.recreateWorkflowFromFreshBase = vi.fn().mockResolvedValue([scoped, crossWorkflow]);
    mocks.orchestrator.startExecution.mockReturnValue([]);

    const res = await request(port, 'POST', '/api/workflows/wf-1/recreate-with-rebase');

    expect(res.status).toBe(200);
    expect(mocks.taskExecutor.executeTasks).toHaveBeenCalledTimes(2);
    expect(mocks.taskExecutor.executeTasks).toHaveBeenNthCalledWith(1, [scoped]);
    expect(mocks.taskExecutor.executeTasks).toHaveBeenNthCalledWith(2, [crossWorkflow]);
  });

  it('rebase-and-retry still works as deprecated alias', async () => {
    mocks.orchestrator.recreateWorkflowFromFreshBase = vi.fn().mockResolvedValue([makeTask()]);
    const res = await request(port, 'POST', '/api/workflows/wf-1/rebase-and-retry');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.action).toBe('rebase_and_retried');
    expect(res.body.deprecated).toBe(true);
    expect(res.body.replacement).toBe('/api/workflows/:id/recreate-with-rebase');
  });

  it('returns 404 when workflow not found', async () => {
    mocks.persistence.loadWorkflow.mockReturnValue(undefined);
    const res = await request(port, 'POST', '/api/workflows/wf-missing/recreate-with-rebase');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not found');
  });
});

describe('DELETE /api/workflows/:id', () => {
  it('deletes workflow via facade deleteWorkflow', async () => {
    const res = await request(port, 'DELETE', '/api/workflows/wf-1');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.action).toBe('deleted');
    expect(mocks.killRunningTask).toHaveBeenCalledWith('task-1');
    expect(mocks.orchestrator.deleteWorkflow).toHaveBeenCalledWith('wf-1');
  });

  it('returns 404 when workflow not found', async () => {
    mocks.orchestrator.deleteWorkflow.mockImplementationOnce(() => {
      throw new OrchestratorError(OrchestratorErrorCode.WORKFLOW_NOT_FOUND, 'workflow not found');
    });
    const res = await request(port, 'DELETE', '/api/workflows/missing');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('workflow not found');
  });
});

describe('POST /api/workflows/:id/detach', () => {
  it('detaches workflow from one upstream workflow', async () => {
    const res = await request(port, 'POST', '/api/workflows/wf-1/detach', {
      upstreamWorkflowId: 'wf-0',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.action).toBe('detached');
    expect(mocks.orchestrator.detachWorkflow).toHaveBeenCalledWith('wf-1', 'wf-0');
  });

  it('returns 400 when upstreamWorkflowId is missing', async () => {
    const res = await request(port, 'POST', '/api/workflows/wf-1/detach', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing "upstreamWorkflowId"');
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

describe('INV-91 deterministic control-plane boundaries', () => {
  it('keeps orchestrator mutation ownership centralized', () => {
    const source = readRepoFile('packages/workflow-core/src/orchestrator.ts');

    expect(matchCount(source, /private refreshFromDb\(/g)).toBe(1);
    expect(matchCount(source, /private writeAndSync\(/g)).toBe(1);
    expect(matchCount(source, /messageBus\.publish\(TASK_DELTA_CHANNEL/g)).toBeGreaterThanOrEqual(1);
    expect(source).toContain('INV-91');
  });

  it('keeps IPC API shape derived from centralized channel registries', () => {
    const source = readRepoFile('packages/contracts/src/ipc-channels.ts');

    expect(matchCount(source, /export const IpcChannels|export const IpcEventChannels|export type InvokerAPI|type ChannelToMethod/g)).toBe(4);
    expect(matchCount(source, /^  'invoker:/gm)).toBeGreaterThanOrEqual(60);
    expect(source).toContain('INV-91');
  });

  it('keeps HTTP writes facade-backed and direct orchestrator calls read-only', () => {
    const source = readRepoFile('packages/app/src/api-server.ts');
    const directOrchestratorCalls = Array.from(source.matchAll(/orchestrator\.([a-zA-Z0-9_]+)/g), (match) => match[1]);

    expect(matchCount(source, /^      if \(method === 'POST'/gm)).toBeGreaterThanOrEqual(15);
    expect(matchCount(source, /mutations\./g)).toBeGreaterThanOrEqual(15);
    expect(directOrchestratorCalls).toEqual([
      'getWorkflowStatus',
      'getAllTasks',
      'getTask',
      'getQueueStatus',
    ]);
    expect(source).toContain("server.listen(port, '127.0.0.1'");
    expect(source).toContain('INV-91');
  });
});
