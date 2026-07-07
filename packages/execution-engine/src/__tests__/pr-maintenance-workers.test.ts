import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { Logger } from '@invoker/contracts';

import {
  CODERABBIT_ADDRESS_WORKER_KIND,
  DEFAULT_PR_MAINTENANCE_WORKER_INTERVAL_MS,
  PR_CONFLICT_REBASE_WORKER_KIND,
  createCoderabbitAddressWorker,
  createPrConflictRebaseWorker,
  type PrMaintenanceCommandResult,
  type PrMaintenanceCommandRun,
  type PrMaintenanceCommandRunner,
  type PrMaintenanceWorkerStore,
  type PrMaintenanceWorkerSubmitter,
} from '../workers/pr-maintenance-workers.js';

interface LoggerSpy extends Logger {
  info: Mock;
  warn: Mock;
  error: Mock;
  debug: Mock;
  child: Mock;
}

interface CommandRunnerHarness {
  calls: PrMaintenanceCommandRun[];
  run: Mock;
  runner: PrMaintenanceCommandRunner;
}

interface StoreHarness {
  store: PrMaintenanceWorkerStore;
  findReviewGateByPr: Mock;
  loadTasks: Mock;
  loadWorkflow: Mock;
}

function makeLogger(): LoggerSpy {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  } as unknown as LoggerSpy;
  logger.child.mockReturnValue(logger);
  return logger;
}

function makeCommandRunner(
  handler: (call: PrMaintenanceCommandRun) => Promise<PrMaintenanceCommandResult> | PrMaintenanceCommandResult,
): CommandRunnerHarness {
  const calls: PrMaintenanceCommandRun[] = [];
  const run = vi.fn(async (call: PrMaintenanceCommandRun) => {
    calls.push(call);
    return handler(call);
  });
  return {
    calls,
    run,
    runner: { run },
  };
}

function makeStoreHarness(): StoreHarness {
  const findReviewGateByPr = vi.fn();
  const loadTasks = vi.fn(() => []);
  const loadWorkflow = vi.fn();
  return {
    findReviewGateByPr,
    loadTasks,
    loadWorkflow,
    store: {
      findReviewGateByPr,
      loadTasks,
      loadWorkflow,
    },
  };
}

function makeSubmitter(): { submitter: PrMaintenanceWorkerSubmitter; submit: Mock } {
  const submit = vi.fn(() => 101);
  return {
    submitter: { submit },
    submit,
  };
}

describe('PR maintenance workers', () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    while (tmpRoots.length > 0) {
      const root = tmpRoots.pop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  function makeRepoRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'invoker-pr-maintenance-test-'));
    tmpRoots.push(root);
    return root;
  }

  it('runs the CodeRabbit backend directly and logs OMP output', async () => {
    const repoRoot = makeRepoRoot();
    const lockPath = join(repoRoot, 'locks', 'pr-crons.lock');
    const stateFile = join(repoRoot, 'state', 'coderabbit.tsv');
    const workdir = join(repoRoot, 'workdir');
    const logger = makeLogger();
    const storeHarness = makeStoreHarness();
    storeHarness.findReviewGateByPr.mockReturnValue({
      workflowId: 'wf-1',
      mergeTaskId: '__merge__wf-1',
      workflowStatus: 'running',
      workflowGeneration: 2,
      mergeTaskStatus: 'review_ready',
    });
    storeHarness.loadTasks.mockReturnValue([{ id: 'wf-1/task-a', status: 'completed' }]);
    const commandRunner = makeCommandRunner(async (call) => {
      if (call.command === 'gh' && call.args[0] === 'pr' && call.args[1] === 'list') {
        return {
          code: 0,
          stdout: JSON.stringify([{ number: 7, title: 'Fix bug', headRefName: 'stack/head', baseRefName: 'main' }]),
          stderr: '',
        };
      }
      if (call.command === 'gh' && call.args[0] === 'api' && call.args[1] === 'repos/owner/repo/pulls/7/comments?per_page=100') {
        return {
          code: 0,
          stdout: JSON.stringify([{ user: { login: 'coderabbitai[bot]' }, body: 'real issue', updated_at: '2026-07-07T12:00:00Z', path: 'src/a.ts', html_url: 'https://example.test/comment' }]),
          stderr: '',
        };
      }
      if (call.command === 'gh' && call.args[0] === 'api' && call.args[1] === 'repos/owner/repo/issues/7/comments?per_page=100') {
        return { code: 0, stdout: '[]', stderr: '' };
      }
      if (call.command === 'gh' && call.args[0] === 'pr' && call.args[1] === 'view') {
        return {
          code: 0,
          stdout: JSON.stringify({ title: 'Fix bug', body: 'PR body', headRefName: 'stack/head', baseRefName: 'main' }),
          stderr: '',
        };
      }
      if (call.command === 'gh' && call.args[0] === 'repo' && call.args[1] === 'clone') {
        return { code: 0, stdout: '', stderr: '' };
      }
      if (call.command === 'gh' && call.args[0] === 'pr' && call.args[1] === 'checkout') {
        return { code: 0, stdout: '', stderr: '' };
      }
      if (call.command === 'git' && call.args.join(' ') === 'fetch --quiet --all') {
        return { code: 0, stdout: '', stderr: '' };
      }
      if (call.command === 'git' && call.args.join(' ') === 'reset --hard') {
        return { code: 0, stdout: '', stderr: '' };
      }
      if (call.command === 'git' && call.args.join(' ') === 'clean -fd') {
        return { code: 0, stdout: '', stderr: '' };
      }
      if (call.command === 'omp') {
        return { code: 0, stdout: 'addressed one PR\n', stderr: 'diagnostic line\n' };
      }
      throw new Error(`Unexpected command: ${call.command} ${call.args.join(' ')}`);
    });

    const worker = createCoderabbitAddressWorker({
      logger,
      repoRoot,
      lockPath,
      store: storeHarness.store,
      commandRunner: commandRunner.runner,
      env: {
        INVOKER_GITHUB_TARGET_REPO: 'owner/repo',
        INVOKER_PR_CRON_AUTHOR: 'octocat',
        INVOKER_PR_CODERABBIT_STATE_FILE: stateFile,
        INVOKER_PR_CRON_WORKDIR: workdir,
      },
      installSignalHandlers: false,
    });

    await worker.tick();

    expect(commandRunner.calls.some((call) => call.command === 'bash')).toBe(false);
    expect(commandRunner.calls.map((call) => `${call.command} ${call.args.slice(0, 2).join(' ')}`)).toContain('omp --no-title --auto-approve');
    expect(storeHarness.findReviewGateByPr).toHaveBeenCalledWith('7');
    expect(storeHarness.loadTasks).toHaveBeenCalledWith('wf-1');
    expect(logger.info).toHaveBeenCalledWith(
      `[worker:${CODERABBIT_ADDRESS_WORKER_KIND}] addressed one PR`,
      expect.objectContaining({ stream: 'stdout' }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      `[worker:${CODERABBIT_ADDRESS_WORKER_KIND}] diagnostic line`,
      expect.objectContaining({ stream: 'stderr' }),
    );
  });

  it('queues rebase-recreate through the direct conflict backend', async () => {
    const repoRoot = makeRepoRoot();
    const lockPath = join(repoRoot, 'locks', 'pr-crons.lock');
    const stateFile = join(repoRoot, 'state', 'conflicts.tsv');
    const logger = makeLogger();
    const storeHarness = makeStoreHarness();
    let generation = 2;
    storeHarness.findReviewGateByPr.mockReturnValue({
      workflowId: 'wf-1',
      mergeTaskId: '__merge__wf-1',
      workflowStatus: 'running',
      workflowGeneration: generation,
      mergeTaskStatus: 'blocked',
    });
    storeHarness.loadWorkflow.mockImplementation(() => ({ id: 'wf-1', generation }));
    const submitterHarness = makeSubmitter();
    submitterHarness.submit.mockImplementation(() => {
      generation = 3;
      return 101;
    });
    const commandRunner = makeCommandRunner(async (call) => {
      if (call.command === 'gh' && call.args[0] === 'pr' && call.args[1] === 'list') {
        return {
          code: 0,
          stdout: JSON.stringify([{ number: 11, mergeStateStatus: 'DIRTY' }]),
          stderr: '',
        };
      }
      throw new Error(`Unexpected command: ${call.command} ${call.args.join(' ')}`);
    });

    const worker = createPrConflictRebaseWorker({
      logger,
      repoRoot,
      lockPath,
      store: storeHarness.store,
      submitter: submitterHarness.submitter,
      commandRunner: commandRunner.runner,
      env: {
        INVOKER_GITHUB_TARGET_REPO: 'owner/repo',
        INVOKER_PR_CRON_AUTHOR: 'octocat',
        INVOKER_PR_CONFLICT_STATE_FILE: stateFile,
      },
      installSignalHandlers: false,
    });

    await worker.tick();

    expect(commandRunner.calls.some((call) => call.command === 'bash')).toBe(false);
    expect(submitterHarness.submit).toHaveBeenCalledWith(
      'wf-1',
      'high',
      'headless.exec',
      [{ args: ['rebase-recreate', 'wf-1'], noTrack: true }],
    );
    expect(logger.info).toHaveBeenCalledWith(
      `[worker:${PR_CONFLICT_REBASE_WORKER_KIND}] PR #11: rebase-recreate confirmed (generation 2 -> 3)`,
      expect.objectContaining({ workflowId: 'wf-1', newGeneration: 3 }),
    );
  });

  it('skips cleanly when the shared PR-maintenance lock is already held', async () => {
    const repoRoot = makeRepoRoot();
    const lockPath = join(repoRoot, 'locks', 'pr-crons.lock');
    const logger = makeLogger();
    const commandRunner = makeCommandRunner(async () => ({ code: 0, stdout: '[]', stderr: '' }));
    const worker = createPrConflictRebaseWorker({
      logger,
      repoRoot,
      lockPath,
      commandRunner: commandRunner.runner,
      lockProbe: () => ({ held: true, reason: 'test-lock-held' }),
      installSignalHandlers: false,
    });

    await worker.tick();

    expect(commandRunner.calls).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      `[worker:${PR_CONFLICT_REBASE_WORKER_KIND}] shared PR maintenance lock held; skipping tick`,
      expect.objectContaining({
        worker: PR_CONFLICT_REBASE_WORKER_KIND,
        reason: 'test-lock-held',
      }),
    );
  });

  it('polls on the five-minute default interval without ticking on start', async () => {
    vi.useFakeTimers();
    const repoRoot = makeRepoRoot();
    const lockPath = join(repoRoot, 'locks', 'pr-crons.lock');
    const logger = makeLogger();
    const commandRunner = makeCommandRunner(async (call) => {
      if (call.command === 'gh' && call.args[0] === 'pr' && call.args[1] === 'list') {
        return { code: 0, stdout: '[]', stderr: '' };
      }
      throw new Error(`Unexpected command: ${call.command} ${call.args.join(' ')}`);
    });
    const worker = createCoderabbitAddressWorker({
      logger,
      repoRoot,
      lockPath,
      commandRunner: commandRunner.runner,
      env: {
        INVOKER_GITHUB_TARGET_REPO: 'owner/repo',
        INVOKER_PR_CRON_AUTHOR: 'octocat',
        INVOKER_PR_CODERABBIT_STATE_FILE: join(repoRoot, 'state', 'coderabbit.tsv'),
        INVOKER_PR_CRON_WORKDIR: join(repoRoot, 'workdir'),
      },
      installSignalHandlers: false,
    });

    worker.start();
    expect(commandRunner.calls).toEqual([]);

    await vi.advanceTimersByTimeAsync(DEFAULT_PR_MAINTENANCE_WORKER_INTERVAL_MS - 1);
    expect(commandRunner.calls).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(commandRunner.calls).toHaveLength(1);
    await worker.stop();
  });
});
