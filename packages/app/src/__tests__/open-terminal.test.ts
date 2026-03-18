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
import type { TaskStateChanges } from '@invoker/graph';
import {
  LocalFamiliar, DockerFamiliar, WorktreeFamiliar, FamiliarRegistry,
  type FamiliarHandle, type TerminalSpec, type PersistedTaskMeta,
} from '@invoker/executors';
import type { WorkResponse, WorkRequest } from '@invoker/protocol';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});
import { existsSync } from 'node:fs';

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
  updateTask(taskId: string, changes: TaskStateChanges): void {
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
    actionType: task.config.command ? 'command' : 'claude',
    inputs: {
      command: task.config.command,
      prompt: task.config.prompt,
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

// ── Per-executor getRestoredTerminalSpec tests ────────────────
// Verifies that each familiar type correctly builds a TerminalSpec
// from persisted DB metadata via getRestoredTerminalSpec().

describe('getRestoredTerminalSpec routing', () => {
  afterEach(() => {
    vi.mocked(existsSync).mockReset();
  });

  describe('LocalFamiliar', () => {
    const local = new LocalFamiliar();

    it('returns claude --resume spec with cwd for worktree-like task with session', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const meta: PersistedTaskMeta = {
        taskId: 'task-1',
        familiarType: 'local',
        claudeSessionId: 'abc-123-session',
        workspacePath: '/home/user/repo',
      };
      const spec = local.getRestoredTerminalSpec(meta);
      expect(spec.command).toBe('claude');
      expect(spec.args).toContain('--resume');
      expect(spec.args).toContain('abc-123-session');
      expect(spec.cwd).toBe('/home/user/repo');
    });

    it('returns cwd-only spec for command task without session', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const meta: PersistedTaskMeta = {
        taskId: 'task-cmd',
        familiarType: 'local',
        workspacePath: '/home/user/repo',
      };
      const spec = local.getRestoredTerminalSpec(meta);
      expect(spec.command).toBeUndefined();
      expect(spec.cwd).toBe('/home/user/repo');
    });

    it('returns spec with undefined cwd when workspace_path is not set', () => {
      const meta: PersistedTaskMeta = {
        taskId: 'task-unknown',
        familiarType: 'local',
      };
      const spec = local.getRestoredTerminalSpec(meta);
      expect(spec.cwd).toBeUndefined();
    });

    it('throws when workspace path no longer exists', () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const meta: PersistedTaskMeta = {
        taskId: 'task-missing',
        familiarType: 'local',
        workspacePath: '/tmp/gone',
      };
      expect(() => local.getRestoredTerminalSpec(meta)).toThrow(/no longer exists/);
    });
  });

  describe('WorktreeFamiliar', () => {
    it('returns cwd spec for worktree with existing path', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const wt = new WorktreeFamiliar({ repoDir: '/tmp/repo', worktreeBaseDir: '/tmp/wt', cacheDir: '/tmp/cache' });
      const meta: PersistedTaskMeta = {
        taskId: 'task-wt',
        familiarType: 'worktree',
        workspacePath: '/home/user/.invoker/worktrees/wt-abc',
      };
      const spec = wt.getRestoredTerminalSpec(meta);
      expect(spec.cwd).toBe('/home/user/.invoker/worktrees/wt-abc');
    });

    it('throws when worktree path no longer exists', () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const wt = new WorktreeFamiliar({ repoDir: '/tmp/repo', worktreeBaseDir: '/tmp/wt', cacheDir: '/tmp/cache' });
      const meta: PersistedTaskMeta = {
        taskId: 'task-wt-gone',
        familiarType: 'worktree',
        workspacePath: '/home/user/.invoker/worktrees/deleted-wt',
      };
      expect(() => wt.getRestoredTerminalSpec(meta)).toThrow(/no longer exists.*cleaned up/);
    });
  });

  describe('DockerFamiliar', () => {
    const docker = new DockerFamiliar({ workspaceDir: '/tmp' });

    it('returns docker exec spec with session resume', () => {
      const meta: PersistedTaskMeta = {
        taskId: 'task-docker',
        familiarType: 'docker',
        claudeSessionId: 'docker-session-1',
        containerId: 'container-abc',
      };
      const spec = docker.getRestoredTerminalSpec(meta);
      expect(spec.command).toBe('bash');
      expect(spec.args![1]).toContain('claude --resume docker-session-1');
      expect(spec.args![1]).toContain('docker start container-abc');
    });

    it('returns docker exec spec without session (bash fallback)', () => {
      const meta: PersistedTaskMeta = {
        taskId: 'task-docker-cmd',
        familiarType: 'docker',
        containerId: 'container-xyz',
      };
      const spec = docker.getRestoredTerminalSpec(meta);
      expect(spec.command).toBe('bash');
      expect(spec.args![1]).toContain('/bin/bash');
      expect(spec.args![1]).not.toContain('claude --resume');
    });

    it('throws when no container ID provided', () => {
      const meta: PersistedTaskMeta = {
        taskId: 'task-no-cid',
        familiarType: 'docker',
      };
      expect(() => docker.getRestoredTerminalSpec(meta)).toThrow(/No container ID/);
    });
  });
});

// ── Merge gate open-terminal regression ───────────────────────

describe('merge gate open-terminal', () => {
  afterEach(() => {
    vi.mocked(existsSync).mockReset();
  });

  it('resolves merge gate familiar to local', () => {
    const registry = new FamiliarRegistry();
    const local = new LocalFamiliar();
    registry.register('local', local);

    const meta: PersistedTaskMeta = {
      taskId: '__merge__wf-123',
      familiarType: 'merge',
      workspacePath: process.cwd(),
    };

    let familiar = registry.get(meta.familiarType);
    if (!familiar) {
      if (meta.familiarType === 'docker') {
        /* lazy-register docker */
      } else if (meta.familiarType === 'worktree') {
        /* lazy-register worktree */
      } else {
        familiar = registry.get('local') ?? registry.getDefault();
      }
    }

    expect(familiar).toBe(local);
    expect(familiar!.type).toBe('local');
  });

  it('opens terminal with git checkout for merge gate with branch', () => {
    const registry = new FamiliarRegistry();
    const local = new LocalFamiliar();
    registry.register('local', local);

    const meta: PersistedTaskMeta = {
      taskId: '__merge__wf-123',
      familiarType: 'merge',
      workspacePath: process.cwd(),
      branch: 'plan/my-workflow',
    };

    let familiar: any = registry.get(meta.familiarType);
    if (!familiar) {
      familiar = registry.get('local') ?? registry.getDefault();
    }

    vi.mocked(existsSync).mockReturnValue(true);
    const spec = familiar.getRestoredTerminalSpec(meta);
    expect(spec.cwd).toBe(process.cwd());
    expect(spec.command).toBe('bash');
    expect(spec.args).toContain('-c');
    expect(spec.args![1]).toContain("git checkout 'plan/my-workflow'");
  });

  it('opens terminal with cwd only for merge gate without branch', () => {
    const registry = new FamiliarRegistry();
    const local = new LocalFamiliar();
    registry.register('local', local);

    const meta: PersistedTaskMeta = {
      taskId: '__merge__wf-123',
      familiarType: 'merge',
      workspacePath: process.cwd(),
    };

    let familiar: any = registry.get(meta.familiarType);
    if (!familiar) {
      familiar = registry.get('local') ?? registry.getDefault();
    }

    vi.mocked(existsSync).mockReturnValue(true);
    const spec = familiar.getRestoredTerminalSpec(meta);
    expect(spec.cwd).toBe(process.cwd());
    expect(spec.command).toBeUndefined();
  });
});
