import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SshExecutor } from '../ssh-executor.js';
import type { WorkRequest } from '@invoker/contracts';

function makeRequest(overrides: Partial<WorkRequest> = {}): WorkRequest {
  return {
    requestId: 'req-1',
    actionId: 'test-task',
    actionType: 'command',
    inputs: { command: 'echo hello', description: 'test' },
    callbackUrl: '',
    timestamps: { createdAt: new Date().toISOString() },
    ...overrides,
  };
}

function createMockProcess(): ChildProcess & EventEmitter {
  const proc = new EventEmitter() as ChildProcess & EventEmitter;
  (proc as any).stdout = new EventEmitter();
  (proc as any).stderr = new EventEmitter();
  (proc as any).stdin = { write: vi.fn(), end: vi.fn() };
  (proc as any).pid = 12345;
  (proc as any).killed = false;
  (proc as any).exitCode = null;
  proc.kill = vi.fn().mockReturnValue(true);
  return proc;
}

let spawnedProcesses: Array<ChildProcess & EventEmitter> = [];

vi.mock('node:child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:child_process');
  return {
    ...actual,
    spawn: vi.fn((..._args: any[]) => {
      const proc = createMockProcess();
      spawnedProcesses.push(proc);
      return proc;
    }),
  };
});

const CATSTACK_SSH_URL = 'git@github.com:EdbertChan/catstack.git';
const TARGET_PROVISION = 'printf target > "$HOME/target.log"';
const REPO_PROVISION = 'printf repo > "$HOME/repo.log"';

interface RunResult {
  status: number | null;
  stdout: string;
  bootstrapScript: string;
  fakeHome: string;
  workspacePath: string;
}

async function runManagedBootstrap(
  repoProvisionCommands: Record<string, string>,
  lockfile: 'package-lock.json' | 'pnpm-lock.yaml',
  assertions: (result: RunResult) => void,
): Promise<void> {
  const ssh = new SshExecutor({
    host: 'localhost',
    user: 'testuser',
    sshKeyPath: '/dev/null',
    managedWorkspaces: true,
    remoteHeartbeatIntervalSeconds: 1,
    remoteInvokerHome: '~/.invoker',
    provisionCommand: TARGET_PROVISION,
    repoProvisionCommands,
  }) as any;

  vi.spyOn(ssh, 'execRemoteCapture').mockImplementation(async (script: string) => {
    if (script.includes('__INVOKER_BASE_REF__=')) {
      return '__INVOKER_BASE_REF__=origin/main\n__INVOKER_BASE_HEAD__=abc123def456abc123def456abc123def456abc1';
    }
    if (script.includes('printf %s "$HOME"')) return '/home/testuser';
    return '';
  });
  vi.spyOn(ssh, 'setupTaskBranch').mockResolvedValue(undefined);

  await ssh.start(makeRequest({
    actionType: 'command',
    inputs: {
      command: "printf 'payload-ran\\n' > payload.out",
      description: 'run tests',
      repoUrl: CATSTACK_SSH_URL,
    },
  }));

  const proc = spawnedProcesses[spawnedProcesses.length - 1];
  const writeMock = (proc.stdin as any).write as ReturnType<typeof vi.fn>;
  const bootstrapScript = writeMock.mock.calls[0]![0] as string;
  const workspaceMatch = bootstrapScript.match(/WT=\$\(normalize_remote_path '([^']+)'\)/);
  if (!workspaceMatch?.[1]) {
    throw new Error('Managed SSH bootstrap did not embed a workspace path');
  }

  const fakeHome = mkdtempSync(join(tmpdir(), 'ssh-repo-provision-home-'));
  try {
    const workspacePath = workspaceMatch[1].replace(/^~(?=\/|$)/, fakeHome);
    mkdirSync(workspacePath, { recursive: true });
    writeFileSync(join(workspacePath, lockfile), '{}\n');

    const childProcessModule = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const result = childProcessModule.spawnSync('/bin/bash', ['-c', bootstrapScript], {
      encoding: 'utf8',
      env: { ...process.env, HOME: fakeHome, PATH: process.env.PATH ?? '' },
    });

    assertions({ status: result.status, stdout: result.stdout, bootstrapScript, fakeHome, workspacePath });
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    proc.emit('close', 0, null);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('SshExecutor managed workspace repoProvisionCommands', () => {
  beforeEach(() => {
    spawnedProcesses = [];
  });

  it('runs the repo entry instead of the target provisionCommand, without the pnpm-lock gate', async () => {
    await runManagedBootstrap(
      { 'https://github.com/EdbertChan/catstack.git': REPO_PROVISION },
      'package-lock.json',
      ({ status, stdout, fakeHome, workspacePath }) => {
        expect(status).toBe(0);
        expect(stdout).toContain('[SshExecutor] Installing managed worktree dependencies...');
        expect(readFileSync(join(fakeHome, 'repo.log'), 'utf8')).toBe('repo');
        expect(existsSync(join(fakeHome, 'target.log'))).toBe(false);
        expect(readFileSync(join(workspacePath, 'payload.out'), 'utf8')).toBe('payload-ran\n');
      },
    );
  });

  it('emits no install block when the repo entry is empty', async () => {
    await runManagedBootstrap(
      { 'https://github.com/EdbertChan/catstack.git': '' },
      'pnpm-lock.yaml',
      ({ status, bootstrapScript, fakeHome, workspacePath }) => {
        expect(status).toBe(0);
        expect(bootstrapScript).not.toContain('ensure_managed_pnpm_workspace');
        expect(existsSync(join(fakeHome, 'repo.log'))).toBe(false);
        expect(existsSync(join(fakeHome, 'target.log'))).toBe(false);
        expect(readFileSync(join(workspacePath, 'payload.out'), 'utf8')).toBe('payload-ran\n');
      },
    );
  });

  it('keeps the target provisionCommand when only another repo has an entry', async () => {
    await runManagedBootstrap(
      { 'https://github.com/other/repo.git': REPO_PROVISION },
      'pnpm-lock.yaml',
      ({ status, bootstrapScript, fakeHome }) => {
        expect(status).toBe(0);
        expect(bootstrapScript).toContain('ensure_managed_pnpm_workspace');
        expect(readFileSync(join(fakeHome, 'target.log'), 'utf8')).toBe('target');
        expect(existsSync(join(fakeHome, 'repo.log'))).toBe(false);
      },
    );
  });
});
