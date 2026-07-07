import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@invoker/contracts';

import {
  CODERABBIT_ADDRESS_WORKER_KIND,
  createCoderabbitAddressWorker,
  createMergifyRequeueWorker,
  createPrConflictRebaseWorker,
} from '../workers/pr-maintenance-workers.js';
import { acquireWorkerLock } from '../worker-lock.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

const spawnMock = vi.mocked(spawn);

function logger(): Logger {
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => log,
  };
  return log;
}

function mockChild(exitCode: number, stdout = '', stderr = ''): ReturnType<typeof spawn> {
  const child = new EventEmitter() as ReturnType<typeof spawn>;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  setImmediate(() => {
    if (stdout) child.stdout?.write(stdout);
    if (stderr) child.stderr?.write(stderr);
    child.stdout?.end();
    child.stderr?.end();
    child.emit('close', exitCode, null);
  });
  return child;
}

describe('PR maintenance workers', () => {
  let invokerHome: string;
  let originalInvokerDbDir: string | undefined;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    invokerHome = mkdtempSync(join(tmpdir(), 'pr-maintenance-workers-'));
    originalInvokerDbDir = process.env.INVOKER_DB_DIR;
    process.env.INVOKER_DB_DIR = invokerHome;
    spawnMock.mockReset();
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    if (originalInvokerDbDir === undefined) delete process.env.INVOKER_DB_DIR;
    else process.env.INVOKER_DB_DIR = originalInvokerDbDir;
    rmSync(invokerHome, { recursive: true, force: true });
  });

  it('spawns the CodeRabbit address shell tick', async () => {
    spawnMock.mockReturnValueOnce(mockChild(0));
    const worker = createCoderabbitAddressWorker({ logger: logger(), tickOnStart: false, config: { repoRoot: '/repo' } });

    await worker.tick();

    expect(spawnMock).toHaveBeenCalledWith('bash', ['/repo/scripts/cron-coderabbit-address.sh'], expect.objectContaining({ cwd: '/repo' }));
  });

  it('spawns the PR conflict rebase shell tick', async () => {
    spawnMock.mockReturnValueOnce(mockChild(0));
    const worker = createPrConflictRebaseWorker({ logger: logger(), tickOnStart: false, config: { repoRoot: '/repo' } });

    await worker.tick();

    expect(spawnMock).toHaveBeenCalledWith('bash', ['/repo/scripts/cron-pr-conflict-rebase.sh'], expect.objectContaining({ cwd: '/repo' }));
  });

  it('spawns the default Mergify requeue Python argv', async () => {
    spawnMock.mockReturnValueOnce(mockChild(0));
    const worker = createMergifyRequeueWorker({ logger: logger(), tickOnStart: false, config: { repoRoot: '/repo', stateFile: '/tmp/state.jsonl' } });

    await worker.tick();

    expect(spawnMock).toHaveBeenCalledWith('python3', [
      '/repo/scripts/mergify_admin_requeue.py',
      '--once',
      '--repo', 'Neko-Catpital-Labs/Invoker',
      '--author', 'EdbertChan',
      '--state-file', '/tmp/state.jsonl',
    ], expect.objectContaining({ cwd: '/repo' }));
  });

  it('spawns the overridden Mergify requeue argv', async () => {
    spawnMock.mockReturnValueOnce(mockChild(0));
    const worker = createMergifyRequeueWorker({
      logger: logger(),
      tickOnStart: false,
      config: {
        repoRoot: '/repo',
        pythonExecutable: '/usr/bin/python3',
        repo: 'owner/repo',
        author: 'octocat',
        stateFile: '/tmp/state.jsonl',
        extraArgs: ['--dry-run', '--pr', '2969'],
      },
    });

    await worker.tick();

    expect(spawnMock).toHaveBeenCalledWith('/usr/bin/python3', [
      '/repo/scripts/mergify_admin_requeue.py',
      '--once',
      '--repo', 'owner/repo',
      '--author', 'octocat',
      '--state-file', '/tmp/state.jsonl',
      '--dry-run', '--pr', '2969',
    ], expect.objectContaining({ cwd: '/repo' }));
  });

  it('forwards stdout and stderr from the child process', async () => {
    spawnMock.mockReturnValueOnce(mockChild(0, 'out\n', 'err\n'));
    const worker = createCoderabbitAddressWorker({ logger: logger(), tickOnStart: false, config: { repoRoot: '/repo' } });

    await worker.tick();

    expect(stdoutSpy).toHaveBeenCalledWith(expect.objectContaining({}));
    expect(stderrSpy).toHaveBeenCalledWith(expect.objectContaining({}));
  });

  it('logs a non-zero child exit and lets the runtime catch it', async () => {
    spawnMock.mockReturnValueOnce(mockChild(2, '', 'boom'));
    const log = logger();
    const worker = createCoderabbitAddressWorker({ logger: log, tickOnStart: false, config: { repoRoot: '/repo' } });

    await worker.tick();

    expect(log.error).toHaveBeenCalledWith('[worker:coderabbit-address] tick failed', expect.objectContaining({ stderr: 'boom' }));
  });

  it('skips spawning when another PR maintenance worker holds the shared lock', async () => {
    const log = logger();
    const held = acquireWorkerLock({ kind: 'pr-maintenance', homeRoot: invokerHome, logger: log });
    try {
      const worker = createCoderabbitAddressWorker({ logger: log, tickOnStart: false, config: { repoRoot: '/repo' } });

      await worker.tick();

      expect(spawnMock).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        '[worker:coderabbit-address] another PR maintenance worker is running; skipping tick',
        expect.objectContaining({ kind: CODERABBIT_ADDRESS_WORKER_KIND }),
      );
    } finally {
      held.release();
    }
  });
});
