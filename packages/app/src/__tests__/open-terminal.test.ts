/**
 * Integration test — Orchestrator + WorktreeExecutor + open-terminal handler.
 *
 * Exercises the same wiring as main.ts without Electron:
 * 1. Load a plan, start execution, run tasks to completion.
 * 2. Verify getTerminalSpec returns correct spec per task.
 * 3. Call the open-terminal logic and verify spawn() is called correctly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';

import {
  Orchestrator,
  type PlanDefinition,
  type TaskState,
  type OrchestratorPersistence,
  type OrchestratorMessageBus,
} from '@invoker/workflow-core';
import type { TaskStateChanges } from '@invoker/workflow-graph';
import {
  DockerExecutor, WorktreeExecutor, ExecutorRegistry, SshExecutor,
  BaseExecutor,
  type ExecutorHandle, type TerminalSpec, type PersistedTaskMeta,
} from '@invoker/execution-engine';
import type { WorkResponse, WorkRequest } from '@invoker/contracts';
vi.mock('../terminal-external-launch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../terminal-external-launch.js')>();
  return {
    ...actual,
    spawnDetachedTerminal: vi.fn(async () => ({ opened: true })),
  };
});
import {
  buildLinuxXTerminalBashScript,
  buildMacOSOsascriptArgs,
  buildTerminalShellCommand,
  spawnDetachedTerminal,
} from '../terminal-external-launch.js';
import { openExternalTerminalForTask } from '../open-terminal-for-task.js';

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
  const defaultCwd = spec?.cwd ?? process.cwd();
  const meta = { cwd: spec?.cwd, command: spec?.command, args: spec?.args };

  if (process.platform === 'linux') {
    const cleanEnv = buildCleanEnv();
    const bashScript = buildLinuxXTerminalBashScript(meta, defaultCwd);
    const termArgs = ['-e', 'bash', '-c', bashScript];

    const child = mockSpawn('x-terminal-emulator', termArgs, {
      detached: true,
      stdio: 'ignore',
      env: cleanEnv,
    });
    child.unref();
  } else if (process.platform === 'darwin') {
    if (spec?.command) {
      const osaArgs = buildMacOSOsascriptArgs(meta, defaultCwd);
      const child = mockSpawn('osascript', osaArgs, { detached: true, stdio: 'ignore' });
      child.unref();
    } else {
      const child = mockSpawn('open', ['-a', 'Terminal', defaultCwd], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    }
  }
}

const taskHandles = new Map<string, ExecutorHandle>();

function executeTaskViaExecutor(
  executor: WorktreeExecutor,
  task: TaskState,
): Promise<WorkResponse> {
  const request: WorkRequest = {
    requestId: randomUUID(),
    actionId: task.id,
    actionType: task.config.command ? 'command' : 'ai_task',
    inputs: {
      command: task.config.command,
      prompt: task.config.prompt,
      workspacePath: process.cwd(),
      repoUrl: '/fake/repo',
      baseBranch: 'master',
    },
    callbackUrl: 'n/a',
    timestamps: { createdAt: new Date().toISOString() },
  };

  return new Promise<WorkResponse>(async (resolve, reject) => {
    try {
      const handle = await executor.start(request);
      taskHandles.set(task.id, handle);
      executor.onComplete(handle, resolve);
    } catch (err) {
      reject(err);
    }
  });
}

// ── Tests ─────────────────────────────────────────────────────

describe('open-terminal integration', () => {
  let orchestrator: Orchestrator;
  let executor: WorktreeExecutor;
  let mockWorktreeDir: string;

  beforeEach(() => {
    const persistence = new InMemoryPersistence();
    const bus = new InMemoryBus();
    executor = new WorktreeExecutor({
      cacheDir: join(tmpdir(), `open-term-cache-${randomUUID()}`),
      worktreeBaseDir: join(tmpdir(), `open-term-wt-${randomUUID()}`),
    });
    orchestrator = new Orchestrator({ persistence, messageBus: bus });
    taskHandles.clear();
    vi.clearAllMocks();

    // Create a real temp directory for the worktree to use
    mockWorktreeDir = join(tmpdir(), `mock-wt-${randomUUID()}`);
    mkdirSync(mockWorktreeDir, { recursive: true });

    // Mock the pool to return our temp directory
    Object.defineProperty(executor, 'pool', {
      value: {
        ensureClone: vi.fn().mockResolvedValue(mockWorktreeDir),
        acquireWorktree: vi.fn().mockResolvedValue({
          worktreePath: mockWorktreeDir,
          branch: 'test-branch',
          release: vi.fn(),
        }),
      },
      writable: true,
      configurable: true,
    });

    // Prevent WorktreeExecutor.start() from running real git on the repo.
    vi.spyOn(BaseExecutor.prototype as any, 'execGitSimple')
      .mockImplementation(async (...a: any[]) => {
        const args = a[0] as string[];
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'abc123';
        if (args[0] === 'rev-parse' && args[1] === '--verify') {
          const ref = String(args[2] ?? '');
          if (ref.includes('origin/')) {
            return 'deadbeef01deadbeef02deadbeef03deadbeef04';
          }
          throw new Error('fatal: Needed a single revision');
        }
        return '';
      });
    vi.spyOn(BaseExecutor.prototype as any, 'syncFromRemote').mockResolvedValue(undefined);
    vi.spyOn(BaseExecutor.prototype as any, 'setupTaskBranch').mockResolvedValue(undefined);
    vi.spyOn(BaseExecutor.prototype as any, 'pushBranchToRemote').mockResolvedValue(undefined);
    vi.spyOn(BaseExecutor.prototype as any, 'recordTaskResult').mockResolvedValue(undefined);
    vi.spyOn(WorktreeExecutor.prototype as any, 'provisionWorktree').mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await executor.destroyAll();
    vi.restoreAllMocks();
    // Clean up temp directory
    try {
      rmSync(mockWorktreeDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
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
    expect(started[0].id.endsWith('/greet')).toBe(true);

    // Execute greet
    const resp1 = await executeTaskViaExecutor(executor, started[0]);
    orchestrator.handleWorkerResponse(resp1);
    expect(orchestrator.getTask('greet')!.status).toBe('completed');

    // Verify getTerminalSpec returns cwd (worktree dir, not repo root)
    const handle = taskHandles.get(started[0].id)!;
    const spec = executor.getTerminalSpec(handle);
    expect(spec?.cwd).toBeDefined();
    expect(spec).toEqual(expect.objectContaining({ cwd: expect.any(String) }));

    // Open terminal using spec
    openExternalTerminal(spec);

    if (process.platform === 'linux') {
      // On Linux, cwd is embedded in the bash script
      expect(mockSpawn).toHaveBeenCalledWith(
        'x-terminal-emulator',
        expect.arrayContaining([expect.stringContaining(spec!.cwd!)]),
        expect.objectContaining({ detached: true, stdio: 'ignore' }),
      );
    } else {
      expect(mockSpawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([spec!.cwd!]),
        expect.objectContaining({ detached: true, stdio: 'ignore' }),
      );
    }
    expect(mockUnref).toHaveBeenCalled();
  }, 15_000);

  it('falls back to process.cwd() when spec is null', () => {
    openExternalTerminal(null);

    if (process.platform === 'linux') {
      // On Linux, cwd is embedded in the bash script
      expect(mockSpawn).toHaveBeenCalledWith(
        'x-terminal-emulator',
        expect.arrayContaining([expect.stringContaining(process.cwd())]),
        expect.objectContaining({ detached: true }),
      );
    } else {
      expect(mockSpawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([process.cwd()]),
        expect.objectContaining({ detached: true }),
      );
    }
  });

  it('directory mode: spawns bash -c with cd and exec bash on linux', () => {
    const spec: TerminalSpec = { cwd: '/tmp/workspace' };
    openExternalTerminal(spec);

    if (process.platform === 'linux') {
      const expectedScript = buildLinuxXTerminalBashScript(
        { cwd: '/tmp/workspace' },
        '/tmp/workspace',
      );
      expect(mockSpawn).toHaveBeenCalledWith(
        'x-terminal-emulator',
        ['-e', 'bash', '-c', expectedScript],
        expect.objectContaining({ detached: true, stdio: 'ignore', env: expect.any(Object) }),
      );
    }
  });

  it('command mode: spawns bash -c with POSIX-quoted argv on linux', () => {
    const spec: TerminalSpec = {
      command: 'docker',
      args: ['exec', '-it', 'container-abc', '/bin/bash'],
    };
    openExternalTerminal(spec);

    if (process.platform === 'linux') {
      const expectedScript = buildLinuxXTerminalBashScript(
        { command: 'docker', args: ['exec', '-it', 'container-abc', '/bin/bash'] },
        process.cwd(),
      );
      expect(mockSpawn).toHaveBeenCalledWith(
        'x-terminal-emulator',
        ['-e', 'bash', '-c', expectedScript],
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

describe('terminal-external-launch', () => {
  it('joins argv with POSIX quotes so bash -c script stays one argument', () => {
    const spec = {
      command: 'bash' as const,
      args: ['-c', `git checkout 'feature/x' 2>/dev/null; exec bash`],
      cwd: '/tmp/wt',
    };
    const line = buildTerminalShellCommand(spec, '/fallback');
    expect(line).toContain(`cd '/tmp/wt'`);
    expect(line).toMatch(/'bash' '-c' '/);
    expect(line).toContain('git checkout');
    expect(line).toContain('feature/x');
  });

  it('uses backslash-quote idiom for embedded single quotes (no double quotes in output)', () => {
    const line = buildTerminalShellCommand(
      { command: 'bash', args: ['-c', "echo 'hello'"] },
      '/tmp',
    );
    // Should use '\'' (backslash-quote) not '"'"' (double-quote idiom)
    expect(line).toContain("\\'");
    expect(line).not.toMatch(/'"'"'/);
  });

  it('buildMacOSOsascriptArgs includes activate and uses multi-line AppleScript', () => {
    const args = buildMacOSOsascriptArgs(
      { command: 'echo', args: ['a"b'], cwd: '/tmp' },
      '/tmp',
    );
    // Multi-line: tell, activate, do script, end tell
    expect(args).toEqual(expect.arrayContaining([
      '-e', 'tell application "Terminal"',
      '-e', 'activate',
    ]));
    const doScriptArg = args.find(a => a.startsWith('do script'));
    expect(doScriptArg).toBeDefined();
    expect(doScriptArg).toContain('\\"');
  });
});

// ── Per-executor getRestoredTerminalSpec tests ────────────────
// Verifies that each executor type correctly builds a TerminalSpec
// from persisted DB metadata via getRestoredTerminalSpec().

describe('getRestoredTerminalSpec routing', () => {
  afterEach(() => {
    vi.mocked(existsSync).mockReset();
  });

  describe('WorktreeExecutor', () => {
    const wt = new WorktreeExecutor({ worktreeBaseDir: '/tmp/wt', cacheDir: '/tmp/cache' });

    it('returns claude --resume spec with cwd when session is set', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const meta: PersistedTaskMeta = {
        taskId: 'task-1',
        executorType: 'worktree',
        agentSessionId: 'abc-123-session',
        workspacePath: '/home/user/repo',
      };
      const spec = wt.getRestoredTerminalSpec(meta);
      expect(spec.command).toBe('claude');
      expect(spec.args).toContain('--resume');
      expect(spec.args).toContain('abc-123-session');
      expect(spec.cwd).toBe('/home/user/repo');
    });

    it('returns cwd-only spec for command task without session', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const meta: PersistedTaskMeta = {
        taskId: 'task-cmd',
        executorType: 'worktree',
        workspacePath: '/home/user/repo',
      };
      const spec = wt.getRestoredTerminalSpec(meta);
      expect(spec.command).toBeUndefined();
      expect(spec.cwd).toBe('/home/user/repo');
    });

    it('returns spec with undefined cwd when workspace_path is not set', () => {
      const meta: PersistedTaskMeta = {
        taskId: 'task-unknown',
        executorType: 'worktree',
      };
      const spec = wt.getRestoredTerminalSpec(meta);
      expect(spec.cwd).toBeUndefined();
    });

    it('throws when workspace path no longer exists', () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const meta: PersistedTaskMeta = {
        taskId: 'task-missing',
        executorType: 'worktree',
        workspacePath: '/tmp/gone',
      };
      expect(() => wt.getRestoredTerminalSpec(meta)).toThrow(/no longer exists.*cleaned up/);
    });

    it('returns cwd spec for worktree with existing path', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const meta: PersistedTaskMeta = {
        taskId: 'task-wt',
        executorType: 'worktree',
        workspacePath: '/home/user/.invoker/worktrees/wt-abc',
      };
      const spec = wt.getRestoredTerminalSpec(meta);
      expect(spec.cwd).toBe('/home/user/.invoker/worktrees/wt-abc');
    });

    it('reconciliation-style persisted meta uses checkout spec in worktree dir', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const meta: PersistedTaskMeta = {
        taskId: 'pivot-reconciliation',
        executorType: 'worktree',
        workspacePath: '/home/user/.invoker/worktrees/ab12/experiment-pivot-reconciliation-deadbeef',
        branch: 'experiment/pivot-reconciliation-deadbeef',
      };
      const spec = wt.getRestoredTerminalSpec(meta);
      expect(spec.cwd).toBe(meta.workspacePath);
      expect(spec.command).toBe('bash');
      expect(spec.args![1]).toContain("git checkout 'experiment/pivot-reconciliation-deadbeef'");
      // Regression guard: cwd must be the isolated worktree, never the monorepo root
      // (repro-reconciliation-open-terminal-cwd.sh)
      expect(spec.cwd).not.toBe(process.cwd());
      expect(spec.cwd).toMatch(/worktrees/);
    });

    it('throws when worktree path no longer exists (explicit)', () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const meta: PersistedTaskMeta = {
        taskId: 'task-wt-gone',
        executorType: 'worktree',
        workspacePath: '/home/user/.invoker/worktrees/deleted-wt',
      };
      expect(() => wt.getRestoredTerminalSpec(meta)).toThrow(/no longer exists.*cleaned up/);
    });
  });

  describe('DockerExecutor', () => {
    const docker = new DockerExecutor({});

    it('returns docker exec spec with session resume', () => {
      const meta: PersistedTaskMeta = {
        taskId: 'task-docker',
        executorType: 'docker',
        agentSessionId: 'docker-session-1',
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
        executorType: 'docker',
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
        executorType: 'docker',
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

  it('resolves merge gate fallback to default worktree executor', () => {
    const registry = new ExecutorRegistry();
    const worktree = new WorktreeExecutor({ cacheDir: join(tmpdir(), 'cache'), worktreeBaseDir: join(tmpdir(), 'merge-gate-wt') });
    registry.register('worktree', worktree);

    const meta: PersistedTaskMeta = {
      taskId: '__merge__wf-123',
      executorType: 'merge',
      workspacePath: process.cwd(),
    };

    let executor = registry.get(meta.executorType);
    if (!executor) {
      if (meta.executorType === 'docker') {
        /* lazy-register docker */
      } else if (meta.executorType === 'worktree') {
        /* lazy-register worktree */
      } else {
        executor = registry.getDefault();
      }
    }

    expect(executor).toBe(worktree);
    expect(executor!.type).toBe('worktree');
  });

  it('opens terminal with git checkout for merge gate with branch when workspacePath is a worktree', () => {
    const wtBase = join(tmpdir(), 'merge-gate-wt-b');
    const registry = new ExecutorRegistry();
    const worktree = new WorktreeExecutor({ cacheDir: join(tmpdir(), 'cache'), worktreeBaseDir: wtBase });
    registry.register('worktree', worktree);

    const worktreePath = join(wtBase, 'gate-wt');
    const meta: PersistedTaskMeta = {
      taskId: '__merge__wf-123',
      executorType: 'merge',
      workspacePath: worktreePath,
      branch: 'plan/my-workflow',
    };

    let executor: any = registry.get(meta.executorType);
    if (!executor) {
      executor = registry.getDefault();
    }

    vi.mocked(existsSync).mockReturnValue(true);
    const spec = executor.getRestoredTerminalSpec(meta);
    expect(spec.cwd).toBe(worktreePath);
    expect(spec.command).toBe('bash');
    expect(spec.args).toContain('-c');
    expect(spec.args![1]).toContain("git checkout 'plan/my-workflow'");
    expect(spec.args![1]).not.toContain('worktree add');
  });

  it('opens terminal with git checkout for merge gate with branch when workspacePath is a worktree', () => {
    const wtBase = join(tmpdir(), 'merge-gate-wt-d');
    const registry = new ExecutorRegistry();
    const worktree = new WorktreeExecutor({ cacheDir: join(tmpdir(), 'cache'), worktreeBaseDir: wtBase });
    registry.register('worktree', worktree);

    const worktreePath = join(wtBase, 'existing-wt');
    const meta: PersistedTaskMeta = {
      taskId: '__merge__wf-456',
      executorType: 'merge',
      workspacePath: worktreePath,
      branch: 'plan/my-workflow',
    };

    let executor: any = registry.get(meta.executorType);
    if (!executor) {
      executor = registry.getDefault();
    }

    vi.mocked(existsSync).mockReturnValue(true);
    const spec = executor.getRestoredTerminalSpec(meta);
    expect(spec.cwd).toBe(worktreePath);
    expect(spec.command).toBe('bash');
    expect(spec.args).toContain('-c');
    expect(spec.args![1]).toContain("git checkout 'plan/my-workflow'");
    expect(spec.args![1]).not.toContain('worktree add');
  });

  it('opens terminal with cwd only for merge gate without branch', () => {
    const registry = new ExecutorRegistry();
    const worktree = new WorktreeExecutor({ cacheDir: join(tmpdir(), 'cache'), worktreeBaseDir: join(tmpdir(), 'merge-gate-wt-c') });
    registry.register('worktree', worktree);

    const meta: PersistedTaskMeta = {
      taskId: '__merge__wf-123',
      executorType: 'merge',
      workspacePath: process.cwd(),
    };

    let executor: any = registry.get(meta.executorType);
    if (!executor) {
      executor = registry.getDefault();
    }

    vi.mocked(existsSync).mockReturnValue(true);
    const spec = executor.getRestoredTerminalSpec(meta);
    expect(spec.cwd).toBe(process.cwd());
    expect(spec.command).toBeUndefined();
  });
});

describe('SshExecutor getRestoredTerminalSpec', () => {
  it('uses ssh -t bash -lc with cd and git checkout when workspacePath and branch are set', () => {
    const ssh = new SshExecutor({
      host: 'droplet.example',
      user: 'root',
      sshKeyPath: '/home/me/.ssh/id_rsa',
      port: 2222,
    });
    const meta: PersistedTaskMeta = {
      taskId: 'remote-task',
      executorType: 'ssh',
      workspacePath: '~/.invoker/worktrees/abc123/experiment-remote-task-deadbeef',
      branch: 'experiment/remote-task-deadbeef',
    };
    const spec = ssh.getRestoredTerminalSpec(meta);
    expect(spec.command).toBe('ssh');
    expect(spec.args).toEqual(expect.arrayContaining([
      '-i', '/home/me/.ssh/id_rsa',
      '-p', '2222',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-t', 'root@droplet.example',
    ]));
    const lc = spec.args![spec.args!.length - 1];
    expect(lc).toContain('cd');
    expect(lc).toContain('experiment/remote-task-deadbeef');
    expect(lc).toContain('exec bash -l');
    expect(spec.args!.join(' ')).not.toContain('BatchMode');
  });

  it('returns non-interactive ssh spec when workspacePath is missing', () => {
    const ssh = new SshExecutor({ host: 'h', user: 'u', sshKeyPath: '/k' });
    const spec = ssh.getRestoredTerminalSpec({ taskId: 't', executorType: 'ssh' });

    // When workspacePath is missing, SshExecutor returns a non-interactive BatchMode spec
    // (not an error - the error is enforced by openExternalTerminalForTask's invariant check)
    expect(spec.command).toBe('ssh');
    expect(spec.args).toContain('BatchMode=yes');
    expect(spec.args).not.toContain('-t');
    expect(spec.cwd).toBeUndefined();
  });

  it('deterministic: SSH managed workspace invariant catches missing workspacePath before getRestoredTerminalSpec', async () => {
    // This test verifies the fail-fast invariant at line 208 of open-terminal-for-task.ts
    const mockPersistence = {
      getTaskStatus: vi.fn(() => 'completed'),
      getExecutorType: vi.fn(() => 'ssh'),
      getAgentSessionId: vi.fn(() => null),
      getContainerId: vi.fn(() => null),
      getWorkspacePath: vi.fn(() => null),  // Missing workspace path - invariant violation!
      getBranch: vi.fn(() => 'experiment/test-branch'),
      getRemoteTargetId: vi.fn(() => null),
    };

    const ssh = new SshExecutor({ host: 'h', user: 'u', sshKeyPath: '/k' });
    const registry = new ExecutorRegistry();
    registry.register('ssh', ssh);

    const result = await openExternalTerminalForTask({
      taskId: 'task-ssh-no-workspace',
      persistence: mockPersistence as any,
      executorRegistry: registry,
      repoRoot: '/repo',
    });

    // Must fail with deterministic error text
    expect(result.opened).toBe(false);
    expect(result.reason).toContain('workspace metadata is missing');
    expect(result.reason).toContain('Executor type "ssh" requires a managed workspace');
    expect(result.reason).toContain('workspacePath is not set');
    expect(result.reason).toContain('Recreate the task');
    expect(result.reason).toContain('Refusing to fall back to host repo');

    // Verify no real SSH call attempted
    expect(mockPersistence.getWorkspacePath).toHaveBeenCalledWith('task-ssh-no-workspace');
    expect(mockPersistence.getExecutorType).toHaveBeenCalledWith('task-ssh-no-workspace');
  });

  it('deterministic: SSH success path scaffolding when workspacePath is present', async () => {
    // This test verifies the success path with complete metadata
    const mockPersistence = {
      getTaskStatus: vi.fn(() => 'completed'),
      getExecutorType: vi.fn(() => 'ssh'),
      getAgentSessionId: vi.fn(() => 'ssh-sess-123'),
      getContainerId: vi.fn(() => null),
      getWorkspacePath: vi.fn(() => '~/.invoker/worktrees/abc/experiment-ssh-task'),  // Has workspace!
      getBranch: vi.fn(() => 'experiment/ssh-task'),
      getRemoteTargetId: vi.fn(() => null),
      getExecutionAgent: vi.fn(() => 'claude'),
    };

    const ssh = new SshExecutor({
      host: 'droplet.example',
      user: 'ubuntu',
      sshKeyPath: '/home/user/.ssh/id_rsa',
      port: 2222,
    });
    const registry = new ExecutorRegistry();
    registry.register('ssh', ssh);

    const result = await openExternalTerminalForTask({
      taskId: 'task-ssh-with-workspace',
      persistence: mockPersistence as any,
      executorRegistry: registry,
      repoRoot: '/repo',
    });

    // In headless CI, external terminal launch will fail with "not supported" or similar
    // But the key assertion is: we should NOT fail with the workspace invariant error
    if (!result.opened && result.reason) {
      expect(result.reason).not.toContain('workspace metadata is missing');
      expect(result.reason).not.toContain('requires a managed workspace');
      expect(result.reason).not.toContain('workspacePath is not set');
    }

    // Verify persistence was queried correctly
    expect(mockPersistence.getWorkspacePath).toHaveBeenCalledWith('task-ssh-with-workspace');
    expect(mockPersistence.getBranch).toHaveBeenCalledWith('task-ssh-with-workspace');
  });

  it('SSH managed success regression: spawns ssh -t with correct workspace and branch when metadata is complete', async () => {
    // Regression guard: SSH with complete metadata should proceed through full open-terminal
    // flow and attempt to spawn ssh -t (even if platform spawn fails in CI).
    // This test mocks spawnDetachedTerminal to verify it receives the correct SSH command.

    // Mock the spawn layer
    const mockSpawnDetached = vi.fn(
      async (_cmd: string, _args: string[], _opts: any, _onClose: () => void) =>
        ({ opened: true } as const)
    );
    const { openExternalTerminalForTask: originalOpen } = await import('../open-terminal-for-task.js');
    const terminalLaunch = await import('../terminal-external-launch.js');
    vi.spyOn(terminalLaunch, 'spawnDetachedTerminal').mockImplementation(mockSpawnDetached as any);

    const mockPersistence = {
      getTaskStatus: vi.fn(() => 'completed'),
      getExecutorType: vi.fn(() => 'ssh'),
      getAgentSessionId: vi.fn(() => 'ssh-sess-abc'),
      getContainerId: vi.fn(() => null),
      getWorkspacePath: vi.fn(() => '~/.invoker/worktrees/xyz/experiment-ssh-managed-deadbeef'),
      getBranch: vi.fn(() => 'experiment/ssh-managed-deadbeef'),
      getRemoteTargetId: vi.fn(() => null),
      getExecutionAgent: vi.fn(() => 'claude'),
    };

    const ssh = new SshExecutor({
      host: 'remote.dev',
      user: 'deployer',
      sshKeyPath: '/home/me/.ssh/deploy_key',
      port: 2222,
    });
    const registry = new ExecutorRegistry();
    registry.register('ssh', ssh);

    const result = await originalOpen({
      taskId: 'ssh-managed-task',
      persistence: mockPersistence as any,
      executorRegistry: registry,
      repoRoot: '/local/repo',
    });

    // Key assertion: terminal opened successfully (spawn was called)
    expect(result.opened).toBe(true);
    expect(result.reason).toBeUndefined();

    // Verify spawnDetachedTerminal was called with ssh command
    expect(mockSpawnDetached).toHaveBeenCalledTimes(1);
    const callArgs = mockSpawnDetached.mock.calls[0];
    expect(callArgs).toBeDefined();
    expect(callArgs.length).toBeGreaterThanOrEqual(2);
    const command = callArgs[0];
    const args = callArgs[1];

    if (process.platform === 'linux') {
      // Linux spawns x-terminal-emulator which internally runs ssh
      expect(command).toBe('x-terminal-emulator');
      expect(args).toContain('-e');
      expect(args).toContain('bash');
      expect(args).toContain('-c');
      // The bash script should contain the SSH command
      const bashScriptIndex = args.indexOf('-c');
      expect(bashScriptIndex).toBeGreaterThanOrEqual(0);
      const bashScript = args[bashScriptIndex + 1];
      expect(bashScript).toContain('ssh');
      expect(bashScript).toContain('remote.dev');
      expect(bashScript).toContain('experiment/ssh-managed-deadbeef');
    } else if (process.platform === 'darwin') {
      // macOS spawns osascript
      expect(command).toBe('osascript');
      const scriptContent = args.join(' ');
      expect(scriptContent).toContain('ssh');
      expect(scriptContent).toContain('remote.dev');
    }

    // Verify no workspace invariant error
    expect(mockPersistence.getWorkspacePath).toHaveBeenCalledWith('ssh-managed-task');
    expect(mockPersistence.getBranch).toHaveBeenCalledWith('ssh-managed-task');

    // Reset only the per-test spy. Do not call vi.restoreAllMocks() — it would
    // wipe the module-level vi.mock for spawnDetachedTerminal that subsequent
    // tests rely on, causing "vi.mocked(spawnDetachedTerminal).mockClear is
    // not a function" failures in the fail-fast invariant describe block.
    vi.mocked(terminalLaunch.spawnDetachedTerminal).mockReset();
    vi.mocked(terminalLaunch.spawnDetachedTerminal).mockImplementation(
      async () => ({ opened: true } as const),
    );
  });
});

// ── Codex vs Claude session resume ───────────────────────────
// Proves that getRestoredTerminalSpec with agentRegistry and
// executionAgent='codex' opens a codex session, not claude.

describe('getRestoredTerminalSpec dispatches codex vs claude session resume', () => {
  // Lazy import to avoid circular dep issues at module level
  let registerBuiltinAgents: typeof import('@invoker/execution-engine').registerBuiltinAgents;

  beforeEach(async () => {
    ({ registerBuiltinAgents } = await import('@invoker/execution-engine'));
  });

  afterEach(() => {
    vi.mocked(existsSync).mockReset();
  });

  describe('WorktreeExecutor', () => {
    it('resumes with codex when executionAgent is "codex"', () => {
      const agentRegistry = registerBuiltinAgents();
      const wt = new WorktreeExecutor({
        worktreeBaseDir: '/tmp/wt',
        cacheDir: '/tmp/cache',
        agentRegistry,
      });
      vi.mocked(existsSync).mockReturnValue(true);
      const meta: PersistedTaskMeta = {
        taskId: 'task-codex',
        executorType: 'worktree',
        agentSessionId: 'codex-sess-123',
        workspacePath: '/tmp/workspace',
        executionAgent: 'codex',
      };
      const spec = wt.getRestoredTerminalSpec(meta);
      expect(spec.command).toBe('codex');
      expect(spec.args).toContain('resume');
      expect(spec.args).toContain('codex-sess-123');
      // Must NOT be claude
      expect(spec.command).not.toBe('claude');
      expect(spec.args).not.toContain('--resume');
      expect(spec.args).not.toContain('--dangerously-skip-permissions');
    });

    it('resumes with claude when executionAgent is "claude"', () => {
      const agentRegistry = registerBuiltinAgents();
      const wt = new WorktreeExecutor({
        worktreeBaseDir: '/tmp/wt',
        cacheDir: '/tmp/cache',
        agentRegistry,
      });
      vi.mocked(existsSync).mockReturnValue(true);
      const meta: PersistedTaskMeta = {
        taskId: 'task-claude',
        executorType: 'worktree',
        agentSessionId: 'claude-sess-456',
        workspacePath: '/tmp/workspace',
        executionAgent: 'claude',
      };
      const spec = wt.getRestoredTerminalSpec(meta);
      expect(spec.command).toBe('claude');
      expect(spec.args).toContain('--resume');
      expect(spec.args).toContain('claude-sess-456');
      expect(spec.args).toContain('--dangerously-skip-permissions');
    });

    it('defaults to claude when executionAgent is undefined', () => {
      const agentRegistry = registerBuiltinAgents();
      const wt = new WorktreeExecutor({
        worktreeBaseDir: '/tmp/wt',
        cacheDir: '/tmp/cache',
        agentRegistry,
      });
      vi.mocked(existsSync).mockReturnValue(true);
      const meta: PersistedTaskMeta = {
        taskId: 'task-default',
        executorType: 'worktree',
        agentSessionId: 'default-sess-789',
        workspacePath: '/tmp/workspace',
        // executionAgent intentionally omitted
      };
      const spec = wt.getRestoredTerminalSpec(meta);
      expect(spec.command).toBe('claude');
    });
  });

  describe('SshExecutor', () => {
    it('resumes with codex on remote when executionAgent is "codex"', () => {
      const agentRegistry = registerBuiltinAgents();
      const ssh = new SshExecutor({
        host: 'droplet.example',
        user: 'root',
        sshKeyPath: '/home/me/.ssh/id_rsa',
        agentRegistry,
      });
      const meta: PersistedTaskMeta = {
        taskId: 'remote-codex',
        executorType: 'ssh',
        agentSessionId: 'codex-remote-sess',
        workspacePath: '~/.invoker/worktrees/abc/experiment-remote-codex',
        branch: 'experiment/remote-codex',
        executionAgent: 'codex',
      };
      const spec = ssh.getRestoredTerminalSpec(meta);
      expect(spec.command).toBe('ssh');
      const innerCmd = spec.args![spec.args!.length - 1];
      expect(innerCmd).toContain('codex');
      expect(innerCmd).toContain('resume');
      expect(innerCmd).toContain('codex-remote-sess');
      // Must NOT be claude --resume
      expect(innerCmd).not.toContain('claude --resume');
    });

    it('resumes with claude on remote when executionAgent is "claude"', () => {
      const agentRegistry = registerBuiltinAgents();
      const ssh = new SshExecutor({
        host: 'droplet.example',
        user: 'root',
        sshKeyPath: '/home/me/.ssh/id_rsa',
        agentRegistry,
      });
      const meta: PersistedTaskMeta = {
        taskId: 'remote-claude',
        executorType: 'ssh',
        agentSessionId: 'claude-remote-sess',
        workspacePath: '~/.invoker/worktrees/abc/experiment-remote-claude',
        branch: 'experiment/remote-claude',
        executionAgent: 'claude',
      };
      const spec = ssh.getRestoredTerminalSpec(meta);
      expect(spec.command).toBe('ssh');
      const innerCmd = spec.args![spec.args!.length - 1];
      expect(innerCmd).toContain('claude');
      expect(innerCmd).toContain('--resume');
      expect(innerCmd).not.toContain('codex');
    });
  });

  describe('DockerExecutor', () => {
    it('resumes with codex inside container when executionAgent is "codex"', () => {
      const agentRegistry = registerBuiltinAgents();
      const docker = new DockerExecutor({ agentRegistry });
      const meta: PersistedTaskMeta = {
        taskId: 'docker-codex',
        executorType: 'docker',
        agentSessionId: 'codex-docker-sess',
        containerId: 'container-xyz',
        executionAgent: 'codex',
      };
      const spec = docker.getRestoredTerminalSpec(meta);
      expect(spec.command).toBe('bash');
      const scriptArg = spec.args![1];
      expect(scriptArg).toContain('codex');
      expect(scriptArg).toContain('exec');
      expect(scriptArg).toContain('resume');
      expect(scriptArg).toContain('codex-docker-sess');
      expect(scriptArg).not.toContain('claude --resume');
    });
  });
});

/**
 * Integration: fixWithAgentImpl persistence writes → OpenTerminalPersistence reads → terminal spec.
 *
 * The previous tests use hand-crafted PersistedTaskMeta. These tests simulate the
 * full persistence round-trip: fixWithAgentImpl writes agentName + agentSessionId,
 * OpenTerminalPersistence reads them, PersistedTaskMeta is constructed exactly as
 * openExternalTerminalForTask does, and getRestoredTerminalSpec dispatches correctly.
 */
describe('fix-with-agent → open-terminal produces correct agent resume command', () => {
  let registerBuiltinAgents: typeof import('@invoker/execution-engine').registerBuiltinAgents;

  beforeEach(async () => {
    ({ registerBuiltinAgents } = await import('@invoker/execution-engine'));
  });

  afterEach(() => {
    vi.mocked(existsSync).mockReset();
  });

  /**
   * Simulates the persistence layer that fixWithAgentImpl writes to and
   * openExternalTerminalForTask reads from. Mirrors how SQLiteAdapter stores
   * agentName and agentSessionId, then exposes them via getExecutionAgent /
   * getAgentSessionId.
   */
  function createMockPersistence() {
    const store = new Map<string, {
      status: string;
      executorType: string;
      agentSessionId?: string;
      agentName?: string;
      workspacePath?: string;
    }>();
    return {
      store,
      // Write side — what fixWithAgentImpl calls
      updateTask(taskId: string, changes: { execution: { agentSessionId: string; agentName: string } }) {
        const existing = store.get(taskId) ?? { status: 'failed', executorType: 'worktree' };
        store.set(taskId, {
          ...existing,
          agentSessionId: changes.execution.agentSessionId,
          agentName: changes.execution.agentName,
        });
      },
      // Read side — what openExternalTerminalForTask calls
      getTaskStatus(taskId: string) { return store.get(taskId)?.status ?? null; },
      getExecutorType(taskId: string) { return store.get(taskId)?.executorType ?? null; },
      getAgentSessionId(taskId: string) { return store.get(taskId)?.agentSessionId ?? null; },
      getExecutionAgent(taskId: string) { return store.get(taskId)?.agentName ?? null; },
      getContainerId() { return null; },
      getWorkspacePath(taskId: string) { return store.get(taskId)?.workspacePath ?? null; },
      getBranch() { return null; },
    };
  }

  it('fix with codex → terminal launches codex, not claude', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const agentRegistry = registerBuiltinAgents();
    const wt = new WorktreeExecutor({
      worktreeBaseDir: '/tmp/wt',
      cacheDir: '/tmp/cache',
      agentRegistry,
    });

    const persistence = createMockPersistence();

    // 1. Simulate initial task state (before fix)
    persistence.store.set('task-codex-fix', {
      status: 'failed',
      executorType: 'worktree',
      workspacePath: '/tmp/workspace',
    });

    // 2. Simulate fixWithAgentImpl writing agentName + sessionId
    persistence.updateTask('task-codex-fix', {
      execution: { agentSessionId: 'codex-sess-42', agentName: 'codex' },
    });

    // 3. Build PersistedTaskMeta exactly as openExternalTerminalForTask does (line 66-74)
    const meta: PersistedTaskMeta = {
      taskId: 'task-codex-fix',
      executorType: persistence.getExecutorType('task-codex-fix') ?? 'worktree',
      agentSessionId: persistence.getAgentSessionId('task-codex-fix') ?? undefined,
      executionAgent: persistence.getExecutionAgent('task-codex-fix') ?? undefined,
      workspacePath: persistence.getWorkspacePath('task-codex-fix') ?? undefined,
    };

    // 4. Verify PersistedTaskMeta was populated from persistence
    expect(meta.executionAgent).toBe('codex');
    expect(meta.agentSessionId).toBe('codex-sess-42');

    // 5. Get terminal spec — should be codex, not claude
    const spec = wt.getRestoredTerminalSpec(meta);
    expect(spec.command).toBe('codex');
    expect(spec.args).toContain('resume');
    expect(spec.args).toContain('codex-sess-42');
    expect(spec.command).not.toBe('claude');
  });

  it('fix with claude → terminal launches claude', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const agentRegistry = registerBuiltinAgents();
    const wt = new WorktreeExecutor({
      worktreeBaseDir: '/tmp/wt',
      cacheDir: '/tmp/cache',
      agentRegistry,
    });

    const persistence = createMockPersistence();
    persistence.store.set('task-claude-fix', {
      status: 'failed',
      executorType: 'worktree',
      workspacePath: '/tmp/workspace',
    });
    persistence.updateTask('task-claude-fix', {
      execution: { agentSessionId: 'claude-sess-99', agentName: 'claude' },
    });

    const meta: PersistedTaskMeta = {
      taskId: 'task-claude-fix',
      executorType: persistence.getExecutorType('task-claude-fix') ?? 'worktree',
      agentSessionId: persistence.getAgentSessionId('task-claude-fix') ?? undefined,
      executionAgent: persistence.getExecutionAgent('task-claude-fix') ?? undefined,
      workspacePath: persistence.getWorkspacePath('task-claude-fix') ?? undefined,
    };

    expect(meta.executionAgent).toBe('claude');
    const spec = wt.getRestoredTerminalSpec(meta);
    expect(spec.command).toBe('claude');
    expect(spec.args).toContain('--resume');
    expect(spec.args).toContain('claude-sess-99');
  });

  it('fix with no agent specified → terminal defaults to claude', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const agentRegistry = registerBuiltinAgents();
    const wt = new WorktreeExecutor({
      worktreeBaseDir: '/tmp/wt',
      cacheDir: '/tmp/cache',
      agentRegistry,
    });

    const persistence = createMockPersistence();
    persistence.store.set('task-noagent', {
      status: 'failed',
      executorType: 'worktree',
      workspacePath: '/tmp/workspace',
      agentSessionId: 'sess-default',
      // agentName intentionally NOT set
    });

    const meta: PersistedTaskMeta = {
      taskId: 'task-noagent',
      executorType: persistence.getExecutorType('task-noagent') ?? 'worktree',
      agentSessionId: persistence.getAgentSessionId('task-noagent') ?? undefined,
      executionAgent: persistence.getExecutionAgent('task-noagent') ?? undefined,
      workspacePath: persistence.getWorkspacePath('task-noagent') ?? undefined,
    };

    // executionAgent is undefined → defaults to claude
    expect(meta.executionAgent).toBeUndefined();
    const spec = wt.getRestoredTerminalSpec(meta);
    expect(spec.command).toBe('claude');
  });

  it('openExternalTerminalForTask: refuses fallback when managed workspace has no workspacePath', async () => {
    const { openExternalTerminalForTask } = await import('../open-terminal-for-task.js');

    // Mock persistence that returns no workspacePath for a worktree executor
    const mockPersistence = {
      getTaskStatus: (_taskId: string) => 'failed',
      getExecutorType: (_taskId: string) => 'worktree',
      getAgentSessionId: (_taskId: string) => null,
      getContainerId: (_taskId: string) => null,
      getWorkspacePath: (_taskId: string) => null, // Missing workspace!
      getBranch: (_taskId: string) => 'invoker/test',
    };

    const registry = new ExecutorRegistry();
    const result = await openExternalTerminalForTask({
      taskId: 'missing-workspace',
      persistence: mockPersistence,
      executorRegistry: registry,
      repoRoot: '/repo',
    });

    expect(result.opened).toBe(false);
    expect(result.reason).toContain('workspace metadata is missing');
    expect(result.reason).toContain('worktree');
    expect(result.reason).toContain('Recovery options');
    expect(result.reason).toContain('Recreate the task');
  });

  it('openExternalTerminalForTask: allows docker executor with workspacePath', async () => {
    const { openExternalTerminalForTask } = await import('../open-terminal-for-task.js');

    // Docker is not in the managed list, but let's verify the invariant doesn't block it
    const mockPersistence = {
      getTaskStatus: (_taskId: string) => 'failed',
      getExecutorType: (_taskId: string) => 'docker',
      getAgentSessionId: (_taskId: string) => null,
      getContainerId: (_taskId: string) => 'abc123',
      getWorkspacePath: (_taskId: string) => '/workspace', // Has workspace
      getBranch: (_taskId: string) => 'invoker/test',
    };

    const registry = new ExecutorRegistry();
    // This should proceed to getRestoredTerminalSpec, which may throw for other reasons
    // but NOT because of the workspace invariant
    const result = await openExternalTerminalForTask({
      taskId: 'docker-with-workspace',
      persistence: mockPersistence,
      executorRegistry: registry,
      repoRoot: '/repo',
    });

    // Even if it fails, the error should not be about missing workspace metadata
    if (!result.opened && result.reason) {
      expect(result.reason).not.toContain('workspace metadata is missing');
    }
  });
});

// ── Fail-fast workspace invariant tests ──────────────────────

describe('openExternalTerminalForTask fail-fast workspace invariant', () => {
  afterEach(() => {
    vi.mocked(existsSync).mockReset();
    vi.mocked(spawnDetachedTerminal).mockClear();
  });

  it('refuses host-repo fallback when worktree task has no workspace path', async () => {
    const mockPersistence = {
      getTaskStatus: vi.fn(() => 'completed'),
      getExecutorType: vi.fn(() => 'worktree'),
      getAgentSessionId: vi.fn(() => null),
      getContainerId: vi.fn(() => null),
      getWorkspacePath: vi.fn(() => null),  // Missing workspace path!
      getBranch: vi.fn(() => null),
    };

    const executor = new WorktreeExecutor({ cacheDir: '/tmp/cache', worktreeBaseDir: '/tmp/wt' });
    const registry = new ExecutorRegistry();
    registry.register('worktree', executor);

    const result = await openExternalTerminalForTask({
      taskId: 'task-no-workspace',
      persistence: mockPersistence as any,
      executorRegistry: registry,
      repoRoot: '/repo',
    });

    expect(result.opened).toBe(false);
    expect(result.reason).toContain('workspace metadata is missing');
    expect(result.reason).toContain('Executor type "worktree" requires a managed workspace');
    expect(result.reason).toContain('Recreate the task');
    expect(result.reason).toContain('Refusing to fall back to host repo');
  });

  it('refuses host-repo fallback when ssh task has no workspace path', async () => {
    const mockPersistence = {
      getTaskStatus: vi.fn(() => 'completed'),
      getExecutorType: vi.fn(() => 'ssh'),
      getAgentSessionId: vi.fn(() => null),
      getContainerId: vi.fn(() => null),
      getWorkspacePath: vi.fn(() => null),  // Missing workspace path!
      getBranch: vi.fn(() => null),
      getRemoteTargetId: vi.fn(() => null),
    };

    const ssh = new SshExecutor({ host: 'h', user: 'u', sshKeyPath: '/k' });
    const registry = new ExecutorRegistry();
    registry.register('ssh', ssh);

    const result = await openExternalTerminalForTask({
      taskId: 'task-ssh-no-workspace',
      persistence: mockPersistence as any,
      executorRegistry: registry,
      repoRoot: '/repo',
    });

    expect(result.opened).toBe(false);
    expect(result.reason).toContain('workspace metadata is missing');
    expect(result.reason).toContain('Executor type "ssh" requires a managed workspace');
  });

  it('refuses host-repo fallback when docker task has no workspace path', async () => {
    const mockPersistence = {
      getTaskStatus: vi.fn(() => 'completed'),
      getExecutorType: vi.fn(() => 'docker'),
      getAgentSessionId: vi.fn(() => null),
      getContainerId: vi.fn(() => 'container-abc'),  // Has container ID
      getWorkspacePath: vi.fn(() => null),  // But missing workspace path!
      getBranch: vi.fn(() => null),
    };

    const docker = new DockerExecutor({});
    const registry = new ExecutorRegistry();
    registry.register('docker', docker);

    const result = await openExternalTerminalForTask({
      taskId: 'task-docker-no-workspace',
      persistence: mockPersistence as any,
      executorRegistry: registry,
      repoRoot: '/repo',
    });

    expect(result.opened).toBe(false);
    expect(result.reason).toContain('workspace metadata is missing');
    expect(result.reason).toContain('Executor type "docker" requires a managed workspace');
  });

  it('allows host-repo fallback for non-managed executor types', async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const mockPersistence = {
      getTaskStatus: vi.fn(() => 'completed'),
      getExecutorType: vi.fn(() => 'local'),  // Non-managed type
      getAgentSessionId: vi.fn(() => null),
      getContainerId: vi.fn(() => null),
      getWorkspacePath: vi.fn(() => null),
      getBranch: vi.fn(() => null),
    };

    // Create a minimal executor for testing
    const mockExecutor = {
      type: 'local',
      getRestoredTerminalSpec: vi.fn(() => ({ cwd: undefined })),
    };

    const registry = new ExecutorRegistry();
    registry.register('local', mockExecutor as any);

    const result = await openExternalTerminalForTask({
      taskId: 'task-local-no-workspace',
      persistence: mockPersistence as any,
      executorRegistry: registry,
      repoRoot: '/repo',
    });

    expect(spawnDetachedTerminal).toHaveBeenCalledTimes(1);

    // For non-managed types, fallback to repoRoot is allowed.
    // External terminal launch can still fail in headless CI, so only assert
    // that we did not trip the managed-workspace invariant.
    if (!result.opened && result.reason) {
      expect(result.reason).not.toContain('workspace metadata is missing');
      expect(result.reason).not.toContain('requires a managed workspace');
    }
  });
});
