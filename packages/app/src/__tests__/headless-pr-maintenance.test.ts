vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
    spawnSync: vi.fn(actual.spawnSync),
  };
});

import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess, SpawnOptions, SpawnSyncReturns } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '@invoker/contracts';
import {
  CODERABBIT_ADDRESS_WORKER_KIND,
  PR_CONFLICT_REBASE_WORKER_KIND,
} from '@invoker/execution-engine';

import type { InvokerConfig } from '../config.js';
import { runHeadless } from '../headless.js';
import type { HeadlessDeps } from '../headless.js';

type SpawnCall = {
  command: string;
  args: string[];
  options: SpawnOptions;
};

function makeLogger(): Logger {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger;
}

function makeSpawnHarness(options: { stdout?: string; stderr?: string; exitCode?: number } = {}) {
  const calls: SpawnCall[] = [];
  const spawnProcess = vi.fn((command: string, args: string[], spawnOptions: SpawnOptions) => {
    calls.push({ command, args, options: spawnOptions });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      stdin: null,
      killed: false,
      pid: 12345,
      kill: vi.fn(),
    }) as unknown as ChildProcess; // Test harness only needs the process fields the worker touches.

    queueMicrotask(() => {
      stdout.end(options.stdout ?? 'completed\n');
      stderr.end(options.stderr ?? '');
      child.emit('close', options.exitCode ?? 0, null);
    });

    return child;
  });

  return { calls, spawnProcess };
}

function makeSpawnSyncResult(status = 0): SpawnSyncReturns<Buffer> {
  return {
    pid: 12345,
    output: [null, Buffer.alloc(0), Buffer.alloc(0)],
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    status,
    signal: null,
  };
}

function makeHeadlessDeps(configOverrides: Partial<InvokerConfig> = {}): HeadlessDeps {
  const deps = {
    logger: makeLogger(),
    persistence: {
      enqueueWorkflowMutationIntent: vi.fn(() => 0),
    },
    invokerConfig: {
      autoFixRetries: 3,
      autoFixAgent: 'codex',
      ...configOverrides,
    },
  };

  // This command path only reads logger, persistence.enqueueWorkflowMutationIntent,
  // and invokerConfig.
  return deps as unknown as HeadlessDeps;
}

describe('headless PR-maintenance workers', () => {
  const tmpRoots: string[] = [];
  let previousDbDir: string | undefined;

  afterEach(() => {
    vi.clearAllMocks();
    if (previousDbDir === undefined) {
      delete process.env.INVOKER_DB_DIR;
    } else {
      process.env.INVOKER_DB_DIR = previousDbDir;
    }
    previousDbDir = undefined;
    while (tmpRoots.length > 0) {
      const path = tmpRoots.pop();
      if (path) rmSync(path, { recursive: true, force: true });
    }
  });

  function makeTmpRoot(prefix: string): string {
    const path = mkdtempSync(join(tmpdir(), prefix));
    tmpRoots.push(path);
    return path;
  }

  function setIsolatedHomeRoot(): void {
    previousDbDir = process.env.INVOKER_DB_DIR;
    process.env.INVOKER_DB_DIR = makeTmpRoot('invoker-headless-pr-maintenance-home-');
  }

  it('lists the PR-maintenance worker kinds on the existing worker entrypoint', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await runHeadless(['worker', 'list'], makeHeadlessDeps());

    const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output).toContain(CODERABBIT_ADDRESS_WORKER_KIND);
    expect(output).toContain(PR_CONFLICT_REBASE_WORKER_KIND);
  });

  it.each([
    [CODERABBIT_ADDRESS_WORKER_KIND, 'scripts/cron-coderabbit-address.sh'],
    [PR_CONFLICT_REBASE_WORKER_KIND, 'scripts/cron-pr-conflict-rebase.sh'],
  ] as const)('runs %s with the owner PR-maintenance config', async (kind, scriptRelativePath) => {
    const repoRoot = makeTmpRoot(`invoker-headless-pr-maintenance-${kind}-`);
    const lockPath = join(repoRoot, 'locks', `${kind}.lock`);
    const spawnHarness = makeSpawnHarness();
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    setIsolatedHomeRoot();
    vi.mocked(spawn).mockImplementation(spawnHarness.spawnProcess);
    vi.mocked(spawnSync).mockReturnValue(makeSpawnSyncResult(0));

    await runHeadless(['worker', kind], makeHeadlessDeps({
      prMaintenance: {
        enabled: true,
        repoRoot,
        lockPath,
        shell: '/bin/zsh',
        env: {
          INVOKER_GITHUB_TARGET_REPO: 'owner/repo',
          INVOKER_PR_CRON_AUTHOR: 'octocat',
        },
      },
    }));

    expect(spawnHarness.calls).toEqual([
      expect.objectContaining({
        command: '/bin/zsh',
        args: [resolve(repoRoot, scriptRelativePath)],
        options: expect.objectContaining({
          cwd: repoRoot,
          env: expect.objectContaining({
            INVOKER_REPO_ROOT: repoRoot,
            INVOKER_PR_CRON_LOCK: lockPath,
            INVOKER_GITHUB_TARGET_REPO: 'owner/repo',
            INVOKER_PR_CRON_AUTHOR: 'octocat',
          }),
        }),
      }),
    ]);
    const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output).toContain(`${kind} worker scan completed.`);
  });
});
