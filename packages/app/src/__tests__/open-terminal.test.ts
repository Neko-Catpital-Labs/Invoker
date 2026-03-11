/**
 * Integration test — Orchestrator + LocalFamiliar + open-terminal handler.
 *
 * Exercises the same wiring as main.ts without Electron:
 * 1. Load a plan, start execution, run tasks to completion.
 * 2. Verify getTerminalSpec returns correct spec per task.
 * 3. Call the open-terminal logic and verify spawn() is called correctly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';

import {
  Orchestrator,
  type PlanDefinition,
  type TaskState,
  type OrchestratorPersistence,
  type OrchestratorMessageBus,
} from '@invoker/core';
import { LocalFamiliar, type FamiliarHandle, type TerminalSpec } from '@invoker/executors';
import type { WorkResponse, WorkRequest } from '@invoker/protocol';

// ── Lightweight in-memory mocks ─────────────────────────────

class InMemoryPersistence implements OrchestratorPersistence {
  workflows = new Map<string, { id: string; name: string; status: string; createdAt: string; updatedAt: string }>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();

  saveWorkflow(workflow: { id: string; name: string; status: string }): void {
    const now = new Date().toISOString();
    this.workflows.set(workflow.id, { ...workflow, createdAt: (workflow as any).createdAt ?? now, updatedAt: (workflow as any).updatedAt ?? now });
  }
  updateWorkflow(workflowId: string, changes: { status?: string }): void {
    const wf = this.workflows.get(workflowId);
    if (wf && changes.status) wf.status = changes.status;
  }
  saveTask(workflowId: string, task: TaskState): void {
    this.tasks.set(task.id, { workflowId, task });
  }
  updateTask(taskId: string, changes: Partial<TaskState>): void {
    const entry = this.tasks.get(taskId);
    if (entry) entry.task = { ...entry.task, ...changes } as TaskState;
  }
  listWorkflows(): Array<{ id: string; name: string; status: string; createdAt: string; updatedAt: string }> {
    return Array.from(this.workflows.values());
  }
  loadTasks(workflowId: string): TaskState[] {
    return Array.from(this.tasks.values())
      .filter((e) => e.workflowId === workflowId)
      .map((e) => e.task);
  }
  logEvent(): void {}
}

class InMemoryBus implements OrchestratorMessageBus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

// ── Mock child_process.spawn ──────────────────────────────────

const mockUnref = vi.fn();
const mockSpawn = vi.fn((..._args: unknown[]) => ({ unref: mockUnref }));

// ── Replicate main.ts open-terminal logic ─────────────────────

function buildCleanEnv(): Record<string, string> {
  const cleanEnv: Record<string, string> = {};
  const keep = ['HOME', 'DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY',
    'SHELL', 'USER', 'TERM', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'LANG'];
  for (const k of keep) {
    if (process.env[k]) cleanEnv[k] = process.env[k]!;
  }
  cleanEnv.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  if (!cleanEnv.TERM) cleanEnv.TERM = 'xterm-256color';
  return cleanEnv;
}

function openExternalTerminal(spec: TerminalSpec | null): void {
  const cwd = spec?.cwd ?? process.cwd();

  if (process.platform === 'linux') {
    const cleanEnv = buildCleanEnv();
    const termArgs = spec?.command
      ? ['-e', spec.command, ...(spec.args ?? [])]
      : ['--working-directory', cwd];

    const child = mockSpawn('x-terminal-emulator', termArgs, {
      detached: true,
      stdio: 'ignore',
      env: cleanEnv,
    });
    child.unref();
  } else if (process.platform === 'darwin') {
    if (spec?.command) {
      const fullCmd = [spec.command, ...(spec.args ?? [])].join(' ');
      const child = mockSpawn('osascript', [
        '-e', `tell application "Terminal" to do script "${fullCmd}"`,
      ], { detached: true, stdio: 'ignore' });
      child.unref();
    } else {
      const child = mockSpawn('open', ['-a', 'Terminal', cwd], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    }
  }
}

const taskHandles = new Map<string, FamiliarHandle>();

function executeTaskViaFamiliar(
  familiar: LocalFamiliar,
  task: TaskState,
): Promise<WorkResponse> {
  const request: WorkRequest = {
    requestId: randomUUID(),
    actionId: task.id,
    actionType: task.command ? 'command' : 'claude',
    inputs: {
      command: task.command,
      prompt: task.prompt,
      workspacePath: process.cwd(),
    },
    callbackUrl: 'n/a',
    timestamps: { createdAt: new Date().toISOString() },
  };

  return new Promise<WorkResponse>(async (resolve, reject) => {
    try {
      const handle = await familiar.start(request);
      taskHandles.set(task.id, handle);
      familiar.onComplete(handle, resolve);
    } catch (err) {
      reject(err);
    }
  });
}

// ── Tests ─────────────────────────────────────────────────────

describe('open-terminal integration', () => {
  let orchestrator: Orchestrator;
  let familiar: LocalFamiliar;

  beforeEach(() => {
    const persistence = new InMemoryPersistence();
    const bus = new InMemoryBus();
    familiar = new LocalFamiliar();
    orchestrator = new Orchestrator({ persistence, messageBus: bus });
    taskHandles.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await familiar.destroyAll();
  });

  it('runs tasks, gets terminal spec, and spawns external terminal', async () => {
    const plan: PlanDefinition = {
      name: 'Terminal Test',
      tasks: [
        { id: 'greet', description: 'Say hello', command: 'echo hello' },
        { id: 'done', description: 'Finish', command: 'echo done', dependencies: ['greet'] },
      ],
    };

    orchestrator.loadPlan(plan);
    const started = orchestrator.startExecution();
    expect(started).toHaveLength(1);
    expect(started[0].id).toBe('greet');

    // Execute greet
    const resp1 = await executeTaskViaFamiliar(familiar, started[0]);
    orchestrator.handleWorkerResponse(resp1);
    expect(orchestrator.getTask('greet')!.status).toBe('completed');

    // Verify getTerminalSpec returns cwd
    const handle = taskHandles.get('greet')!;
    const spec = familiar.getTerminalSpec(handle);
    expect(spec).toEqual({ cwd: process.cwd() });

    // Open terminal using spec
    openExternalTerminal(spec);

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([process.cwd()]),
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
    expect(mockUnref).toHaveBeenCalled();
  }, 15_000);

  it('falls back to process.cwd() when spec is null', () => {
    openExternalTerminal(null);

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([process.cwd()]),
      expect.objectContaining({ detached: true }),
    );
  });

  it('directory mode: spawns --working-directory on linux', () => {
    const spec: TerminalSpec = { cwd: '/tmp/workspace' };
    openExternalTerminal(spec);

    if (process.platform === 'linux') {
      expect(mockSpawn).toHaveBeenCalledWith(
        'x-terminal-emulator',
        ['--working-directory', '/tmp/workspace'],
        expect.objectContaining({ detached: true, stdio: 'ignore', env: expect.any(Object) }),
      );
    }
  });

  it('command mode: spawns -e with command and args on linux', () => {
    const spec: TerminalSpec = {
      command: 'docker',
      args: ['exec', '-it', 'container-abc', '/bin/bash'],
    };
    openExternalTerminal(spec);

    if (process.platform === 'linux') {
      expect(mockSpawn).toHaveBeenCalledWith(
        'x-terminal-emulator',
        ['-e', 'docker', 'exec', '-it', 'container-abc', '/bin/bash'],
        expect.objectContaining({ detached: true, stdio: 'ignore', env: expect.any(Object) }),
      );
    }
  });

  it('uses minimal allowlisted env to avoid snap conflicts on linux', () => {
    openExternalTerminal({ cwd: '/tmp/test' });

    if (process.platform === 'linux') {
      const spawnCall = mockSpawn.mock.calls[0] as unknown[];
      const env = (spawnCall[2] as Record<string, unknown>).env as Record<string, string>;
      expect(env).toHaveProperty('HOME');
      expect(env).toHaveProperty('PATH', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
      expect(env).not.toHaveProperty('GTK_PATH');
      expect(env).not.toHaveProperty('GDK_PIXBUF_MODULE_FILE');
      expect(env).not.toHaveProperty('LD_LIBRARY_PATH');
      expect(env).not.toHaveProperty('SNAP');
    }
  });
});

// ── DB-only terminal routing tests ────────────────────────────
// Replicates the spec-building logic from main.ts open-terminal handler
// to verify correct routing without Electron IPC.

interface MockPersistence {
  getFamiliarType: (taskId: string) => string | null;
  getClaudeSessionId: (taskId: string) => string | null;
  getContainerId: (taskId: string) => string | null;
  getWorkspacePath: (taskId: string) => string | null;
}

/** Mirrors the spec-building logic in main.ts invoker:open-terminal handler. */
function buildTerminalSpec(
  persistence: MockPersistence,
  taskId: string,
  defaultCwd: string,
): { spec: TerminalSpec | null; cwd: string } {
  const familiarType = persistence.getFamiliarType(taskId);
  const sessionId = persistence.getClaudeSessionId(taskId);
  const containerId = persistence.getContainerId(taskId);
  let spec: TerminalSpec | null = null;

  if (familiarType === 'docker' && containerId) {
    const execCmd = sessionId
      ? `docker start ${containerId} >/dev/null 2>&1; docker exec -it ${containerId} claude --resume ${sessionId}`
      : `docker start ${containerId} >/dev/null 2>&1; docker exec -it ${containerId} /bin/bash`;
    spec = { command: 'bash', args: ['-c', execCmd] };
  } else if (sessionId) {
    spec = { command: 'claude', args: ['--resume', sessionId] };
  }

  const wsPath = persistence.getWorkspacePath(taskId);
  const cwd = spec?.cwd ?? wsPath ?? defaultCwd;
  return { spec, cwd };
}

describe('DB-only terminal routing', () => {
  const defaultCwd = '/home/user/repo';

  it('builds claude --resume spec for worktree task with session ID', () => {
    const persistence: MockPersistence = {
      getFamiliarType: () => 'worktree',
      getClaudeSessionId: () => 'abc-123-session',
      getContainerId: () => null,
      getWorkspacePath: () => '/home/user/.invoker/worktrees/wt-uuid',
    };

    const { spec, cwd } = buildTerminalSpec(persistence, 'task-1', defaultCwd);

    expect(spec).toEqual({ command: 'claude', args: ['--resume', 'abc-123-session'] });
    expect(cwd).toBe('/home/user/.invoker/worktrees/wt-uuid');
  });

  it('opens plain terminal for command task without session', () => {
    const persistence: MockPersistence = {
      getFamiliarType: () => 'local',
      getClaudeSessionId: () => null,
      getContainerId: () => null,
      getWorkspacePath: () => '/home/user/repo',
    };

    const { spec, cwd } = buildTerminalSpec(persistence, 'task-cmd', defaultCwd);

    expect(spec).toBeNull();
    expect(cwd).toBe('/home/user/repo');
  });

  it('does not attempt resume when session ID is null', () => {
    const persistence: MockPersistence = {
      getFamiliarType: () => 'worktree',
      getClaudeSessionId: () => null,
      getContainerId: () => null,
      getWorkspacePath: () => '/home/user/.invoker/worktrees/wt-uuid',
    };

    const { spec } = buildTerminalSpec(persistence, 'task-no-session', defaultCwd);

    expect(spec).toBeNull();
  });

  it('uses workspace_path as cwd for worktree resume (not main repo)', () => {
    const persistence: MockPersistence = {
      getFamiliarType: () => 'worktree',
      getClaudeSessionId: () => 'session-xyz',
      getContainerId: () => null,
      getWorkspacePath: () => '/home/user/.invoker/worktrees/wt-abc',
    };

    const { cwd } = buildTerminalSpec(persistence, 'task-wt', defaultCwd);

    // claude --resume spec has no cwd field, so workspace_path is used
    expect(cwd).toBe('/home/user/.invoker/worktrees/wt-abc');
  });

  it('falls back to default cwd when workspace_path is null', () => {
    const persistence: MockPersistence = {
      getFamiliarType: () => 'local',
      getClaudeSessionId: () => null,
      getContainerId: () => null,
      getWorkspacePath: () => null,
    };

    const { cwd } = buildTerminalSpec(persistence, 'task-unknown', defaultCwd);

    expect(cwd).toBe(defaultCwd);
  });

  it('builds docker exec spec with session resume', () => {
    const persistence: MockPersistence = {
      getFamiliarType: () => 'docker',
      getClaudeSessionId: () => 'docker-session-1',
      getContainerId: () => 'container-abc',
      getWorkspacePath: () => null,
    };

    const { spec } = buildTerminalSpec(persistence, 'task-docker', defaultCwd);

    expect(spec?.command).toBe('bash');
    expect(spec?.args?.[1]).toContain('claude --resume docker-session-1');
    expect(spec?.args?.[1]).toContain('docker start container-abc');
  });

  it('builds docker exec spec without session (bash fallback)', () => {
    const persistence: MockPersistence = {
      getFamiliarType: () => 'docker',
      getClaudeSessionId: () => null,
      getContainerId: () => 'container-xyz',
      getWorkspacePath: () => null,
    };

    const { spec } = buildTerminalSpec(persistence, 'task-docker-cmd', defaultCwd);

    expect(spec?.command).toBe('bash');
    expect(spec?.args?.[1]).toContain('/bin/bash');
    expect(spec?.args?.[1]).not.toContain('claude --resume');
  });
});
