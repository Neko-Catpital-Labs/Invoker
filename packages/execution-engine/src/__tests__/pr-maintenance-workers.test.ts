import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
} from '../workers/pr-maintenance-workers.js';
import {
  runCoderabbitAddressTick,
  runPrConflictRebaseTick,
  resolvePrMaintenanceRuntime,
  type PrMaintenanceBackendDeps,
  type ResolvedPrMaintenanceConfig,
} from '../workers/pr-maintenance-backend.js';
import { openPrMaintenanceLedger, type PrMaintenanceLedger } from '../workers/pr-maintenance-ledger.js';
import { acquirePrMaintenanceLock } from '../workers/pr-maintenance-lock.js';

interface MockLogger extends Logger {
  info: Mock;
  warn: Mock;
  error: Mock;
  debug: Mock;
}

function makeLogger(): MockLogger {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger as unknown as MockLogger;
}

interface FakeClock {
  now(): number;
  sleep(ms: number): Promise<void>;
  advance(ms: number): void;
}

function makeClock(startMs = 1_000): FakeClock {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    sleep: vi.fn(async (ms: number) => { nowMs += ms; }),
    advance: (ms: number) => { nowMs += ms; },
  };
}

/** In-memory ledger for backend decision tests (the durable TSV is tested separately). */
function makeMemoryLedger(): PrMaintenanceLedger {
  const rows: Array<{ kind: string; key: string; marker: string }> = [];
  return {
    record: (kind, key, marker) => { rows.push({ kind, key, marker }); },
    count: (kind, key, marker) =>
      rows.filter((r) => r.kind === kind && r.key === key && (marker === undefined || r.marker === marker)).length,
    markerSeen: (kind, key, marker) =>
      rows.some((r) => r.kind === kind && r.key === key && r.marker === marker),
    maxMarker: (kind, key) => {
      let max: string | undefined;
      for (const r of rows) {
        if (r.kind === kind && r.key === key && (max === undefined || r.marker > max)) max = r.marker;
      }
      return max;
    },
  };
}

function makeConfig(over: Partial<ResolvedPrMaintenanceConfig> = {}): ResolvedPrMaintenanceConfig {
  return {
    repoRoot: '/repo',
    env: {},
    targetRepo: 'owner/repo',
    prAuthor: 'octocat',
    coderabbitLogin: 'coderabbitai[bot]',
    dryRun: false,
    lockPath: '/tmp/pr-crons.lock',
    staleLockSeconds: 3600,
    coderabbitStateFile: '/tmp/cr.tsv',
    conflictStateFile: '/tmp/cf.tsv',
    maxCoderabbitAttempts: 3,
    workdir: '/tmp/pr-work',
    workdirMaxAgeDays: 7,
    maxRebaseAttempts: 3,
    confirmTimeoutSeconds: 120,
    ompCommand: 'omp',
    ompTimeout: '45m',
    ...over,
  };
}

function makeDeps(clock: FakeClock = makeClock()): PrMaintenanceBackendDeps {
  return {
    github: {
      listOpenAuthoredPrs: vi.fn(async () => []),
      collectCoderabbitComments: vi.fn(async () => []),
      getPrBody: vi.fn(async () => ''),
      postPrComment: vi.fn(async () => true),
    },
    owner: {
      resolveWorkflowForPr: vi.fn(async () => ({})),
      queryWorkflowTasks: vi.fn(async () => null),
      queryWorkflowGeneration: vi.fn(async () => undefined),
      dispatchRebaseRecreate: vi.fn(async () => true),
    },
    omp: { addressCoderabbitFeedback: vi.fn(async () => true) },
    clock,
    pruneStaleWorkdirs: vi.fn(),
  };
}

describe('pr-maintenance ledger', () => {
  let tmpRoot: string | undefined;
  afterEach(() => {
    if (tmpRoot) { rmSync(tmpRoot, { recursive: true, force: true }); tmpRoot = undefined; }
  });

  function ledgerPath(): string {
    tmpRoot = mkdtempSync(join(tmpdir(), 'invoker-ledger-test-'));
    return join(tmpRoot, 'nested', 'ledger.tsv');
  }

  it('records, counts, and reads markers per (kind, key)', () => {
    const ledger = openPrMaintenanceLedger(ledgerPath());
    ledger.record('coderabbit-attempt', '1', '2024-01-01T00:00:00Z');
    ledger.record('coderabbit-attempt', '1', '2024-01-02T00:00:00Z');
    ledger.record('coderabbit-attempt', '2', '2024-01-02T00:00:00Z');

    // marker-scoped count keeps the cap per feedback batch, not per PR lifetime.
    expect(ledger.count('coderabbit-attempt', '1', '2024-01-02T00:00:00Z')).toBe(1);
    expect(ledger.count('coderabbit-attempt', '1')).toBe(2);
    expect(ledger.count('coderabbit-attempt', '2', '2024-01-01T00:00:00Z')).toBe(0);
    expect(ledger.maxMarker('coderabbit-attempt', '1')).toBe('2024-01-02T00:00:00Z');
    expect(ledger.maxMarker('coderabbit-attempt', 'missing')).toBeUndefined();
  });

  it('detects an exact recorded marker', () => {
    const ledger = openPrMaintenanceLedger(ledgerPath());
    ledger.record('rebase-recreate', 'wf-1', '3');
    expect(ledger.markerSeen('rebase-recreate', 'wf-1', '3')).toBe(true);
    expect(ledger.markerSeen('rebase-recreate', 'wf-1', '4')).toBe(false);
  });

  it('reopens an existing ledger without dropping prior rows', () => {
    const path = ledgerPath();
    openPrMaintenanceLedger(path).record('coderabbit', '1', 'm1');
    const reopened = openPrMaintenanceLedger(path);
    expect(reopened.count('coderabbit', '1')).toBe(1);
  });
});

describe('pr-maintenance lock', () => {
  let tmpRoot: string | undefined;
  afterEach(() => {
    if (tmpRoot) { rmSync(tmpRoot, { recursive: true, force: true }); tmpRoot = undefined; }
  });

  function lockPath(): string {
    tmpRoot = mkdtempSync(join(tmpdir(), 'invoker-lock-test-'));
    return join(tmpRoot, 'pr-crons.lock');
  }

  it('holds the lock until released, blocking a second acquire', () => {
    const path = lockPath();
    const first = acquirePrMaintenanceLock({ lockPath: path });
    expect(first.acquired).toBe(true);

    const second = acquirePrMaintenanceLock({ lockPath: path });
    expect(second.acquired).toBe(false);
    if (!second.acquired) expect(second.reason).toBe('mkdir-lock-held');

    if (first.acquired) first.release();
    const third = acquirePrMaintenanceLock({ lockPath: path });
    expect(third.acquired).toBe(true);
    if (third.acquired) third.release();
  });

  it('reaps a lock whose recorded holder PID is dead', () => {
    const path = lockPath();
    mkdirSync(`${path}.d`, { recursive: true });
    // PID 2**31-1 is effectively never a live process on these platforms.
    writeFileSync(join(`${path}.d`, 'pid'), `${2 ** 31 - 1}\n`);

    const result = acquirePrMaintenanceLock({ lockPath: path });
    expect(result.acquired).toBe(true);
    if (result.acquired) result.release();
  });

  it('never reaps a lock held by a live holder', () => {
    const path = lockPath();
    mkdirSync(`${path}.d`, { recursive: true });
    writeFileSync(join(`${path}.d`, 'pid'), `${process.pid}\n`);

    const result = acquirePrMaintenanceLock({ lockPath: path });
    expect(result.acquired).toBe(false);
  });

  it('reaps a PID-less lock only once it exceeds the age threshold', () => {
    const path = lockPath();
    mkdirSync(`${path}.d`, { recursive: true });

    const fresh = acquirePrMaintenanceLock({ lockPath: path, staleLockSeconds: 3600, now: () => Date.now() });
    expect(fresh.acquired).toBe(false);

    const aged = acquirePrMaintenanceLock({
      lockPath: path,
      staleLockSeconds: 1,
      now: () => Date.now() + 10_000,
    });
    expect(aged.acquired).toBe(true);
    if (aged.acquired) aged.release();
  });
});

describe('coderabbit-address backend', () => {
  it('launches omp once for a PR with new CodeRabbit feedback and records success', async () => {
    const config = makeConfig();
    const deps = makeDeps();
    const ledger = makeMemoryLedger();
    const logger = makeLogger();

    (deps.github.listOpenAuthoredPrs as Mock).mockResolvedValue([
      { number: 42, url: 'u', headRefName: 'feature', baseRefName: 'main', title: 'Feature' },
    ]);
    (deps.github.collectCoderabbitComments as Mock).mockResolvedValue([
      { body: 'fix this', updated_at: '2024-01-02T00:00:00Z', path: 'a.ts', html_url: 'h' },
      { body: 'and this', updated_at: '2024-01-03T00:00:00Z', path: null, html_url: null },
    ]);
    (deps.owner.resolveWorkflowForPr as Mock).mockResolvedValue({ workflowId: 'wf-9' });
    (deps.owner.queryWorkflowTasks as Mock).mockResolvedValue([{ id: 'wf-9/t1' }]);
    (deps.github.getPrBody as Mock).mockResolvedValue('body text');

    await runCoderabbitAddressTick({ config, deps, ledger, logger });

    expect(deps.pruneStaleWorkdirs).toHaveBeenCalledWith('/tmp/pr-work', 7);
    expect(deps.owner.queryWorkflowTasks).toHaveBeenCalledWith('wf-9');
    expect(deps.omp.addressCoderabbitFeedback).toHaveBeenCalledTimes(1);
    expect(deps.omp.addressCoderabbitFeedback).toHaveBeenCalledWith(expect.objectContaining({
      prNumber: '42',
      prTitle: 'Feature',
      prBody: 'body text',
      headBranch: 'feature',
      baseBranch: 'main',
      tasks: [{ id: 'wf-9/t1' }],
      comments: expect.arrayContaining([expect.objectContaining({ body: 'fix this' })]),
    }));
    // Both the attempt and the success marker are recorded at the latest marker.
    expect(ledger.count('coderabbit-attempt', '42', '2024-01-03T00:00:00Z')).toBe(1);
    expect(ledger.markerSeen('coderabbit', '42', '2024-01-03T00:00:00Z')).toBe(true);
  });

  it('skips a PR whose latest CodeRabbit marker is not newer than the last success', async () => {
    const config = makeConfig();
    const deps = makeDeps();
    const ledger = makeMemoryLedger();
    ledger.record('coderabbit', '42', '2024-01-03T00:00:00Z');

    (deps.github.listOpenAuthoredPrs as Mock).mockResolvedValue([{ number: 42, headRefName: 'f', baseRefName: 'm', title: 't' }]);
    (deps.github.collectCoderabbitComments as Mock).mockResolvedValue([
      { body: 'stale', updated_at: '2024-01-03T00:00:00Z', path: null, html_url: null },
    ]);

    await runCoderabbitAddressTick({ config, deps, ledger, logger: makeLogger() });

    expect(deps.omp.addressCoderabbitFeedback).not.toHaveBeenCalled();
  });

  it('skips a PR whose feedback batch already hit the attempt cap', async () => {
    const config = makeConfig({ maxCoderabbitAttempts: 2 });
    const deps = makeDeps();
    const ledger = makeMemoryLedger();
    ledger.record('coderabbit-attempt', '42', '2024-01-03T00:00:00Z');
    ledger.record('coderabbit-attempt', '42', '2024-01-03T00:00:00Z');

    (deps.github.listOpenAuthoredPrs as Mock).mockResolvedValue([{ number: 42, headRefName: 'f', baseRefName: 'm', title: 't' }]);
    (deps.github.collectCoderabbitComments as Mock).mockResolvedValue([
      { body: 'again', updated_at: '2024-01-03T00:00:00Z', path: null, html_url: null },
    ]);

    await runCoderabbitAddressTick({ config, deps, ledger, logger: makeLogger() });

    expect(deps.omp.addressCoderabbitFeedback).not.toHaveBeenCalled();
  });

  it('in dry-run mode logs the intended action and does not launch omp', async () => {
    const config = makeConfig({ dryRun: true });
    const deps = makeDeps();
    (deps.github.listOpenAuthoredPrs as Mock).mockResolvedValue([{ number: 42, headRefName: 'f', baseRefName: 'm', title: 't' }]);
    (deps.github.collectCoderabbitComments as Mock).mockResolvedValue([
      { body: 'x', updated_at: '2024-01-03T00:00:00Z', path: null, html_url: null },
    ]);

    await runCoderabbitAddressTick({ config, deps, ledger: makeMemoryLedger(), logger: makeLogger() });

    expect(deps.omp.addressCoderabbitFeedback).not.toHaveBeenCalled();
  });

  it('processes at most one PR per tick', async () => {
    const config = makeConfig();
    const deps = makeDeps();
    (deps.github.listOpenAuthoredPrs as Mock).mockResolvedValue([
      { number: 1, headRefName: 'f1', baseRefName: 'm', title: 't1' },
      { number: 2, headRefName: 'f2', baseRefName: 'm', title: 't2' },
    ]);
    (deps.github.collectCoderabbitComments as Mock).mockResolvedValue([
      { body: 'x', updated_at: '2024-01-03T00:00:00Z', path: null, html_url: null },
    ]);

    await runCoderabbitAddressTick({ config, deps, ledger: makeMemoryLedger(), logger: makeLogger() });

    expect(deps.omp.addressCoderabbitFeedback).toHaveBeenCalledTimes(1);
    expect(deps.omp.addressCoderabbitFeedback).toHaveBeenCalledWith(expect.objectContaining({ prNumber: '1' }));
  });

  it('exits cleanly when PR listing fails', async () => {
    const deps = makeDeps();
    (deps.github.listOpenAuthoredPrs as Mock).mockResolvedValue(null);
    await runCoderabbitAddressTick({ config: makeConfig(), deps, ledger: makeMemoryLedger(), logger: makeLogger() });
    expect(deps.github.collectCoderabbitComments).not.toHaveBeenCalled();
  });

  it('throws and does not record success when omp exits non-zero', async () => {
    const config = makeConfig();
    const deps = makeDeps();
    const ledger = makeMemoryLedger();
    (deps.github.listOpenAuthoredPrs as Mock).mockResolvedValue([{ number: 42, headRefName: 'f', baseRefName: 'm', title: 't' }]);
    (deps.github.collectCoderabbitComments as Mock).mockResolvedValue([
      { body: 'x', updated_at: '2024-01-03T00:00:00Z', path: null, html_url: null },
    ]);
    (deps.omp.addressCoderabbitFeedback as Mock).mockResolvedValue(false);

    await expect(runCoderabbitAddressTick({ config, deps, ledger, logger: makeLogger() })).rejects.toThrow(/omp failed/);
    expect(ledger.count('coderabbit-attempt', '42', '2024-01-03T00:00:00Z')).toBe(1);
    expect(ledger.markerSeen('coderabbit', '42', '2024-01-03T00:00:00Z')).toBe(false);
  });
});

describe('pr-conflict-rebase backend', () => {
  it('dispatches rebase-recreate for a conflicting PR and confirms via generation advance', async () => {
    const config = makeConfig();
    const clock = makeClock();
    const deps = makeDeps(clock);
    const ledger = makeMemoryLedger();

    (deps.github.listOpenAuthoredPrs as Mock).mockResolvedValue([
      { number: 7, headRefName: 'clean', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
      { number: 8, headRefName: 'dirty', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
    ]);
    (deps.owner.resolveWorkflowForPr as Mock).mockResolvedValue({ workflowId: 'wf-8', workflowGeneration: 2 });
    (deps.owner.queryWorkflowGeneration as Mock).mockResolvedValue(3);

    await runPrConflictRebaseTick({ config, deps, ledger, logger: makeLogger() });

    // Only the conflicting PR is acted on.
    expect(deps.owner.resolveWorkflowForPr).toHaveBeenCalledTimes(1);
    expect(deps.owner.resolveWorkflowForPr).toHaveBeenCalledWith('8');
    expect(deps.owner.dispatchRebaseRecreate).toHaveBeenCalledWith('wf-8');
    expect(ledger.count('rebase-recreate-attempt', 'wf-8', '2')).toBe(1);
    expect(ledger.markerSeen('rebase-recreate', 'wf-8', '2')).toBe(true);
  });

  it('skips a workflow+generation that already fired', async () => {
    const deps = makeDeps();
    const ledger = makeMemoryLedger();
    ledger.record('rebase-recreate', 'wf-8', '2');
    (deps.github.listOpenAuthoredPrs as Mock).mockResolvedValue([{ number: 8, mergeStateStatus: 'DIRTY' }]);
    (deps.owner.resolveWorkflowForPr as Mock).mockResolvedValue({ workflowId: 'wf-8', workflowGeneration: 2 });

    await runPrConflictRebaseTick({ config: makeConfig(), deps, ledger, logger: makeLogger() });

    expect(deps.owner.dispatchRebaseRecreate).not.toHaveBeenCalled();
  });

  it('posts a one-time exhausted comment when the per-generation cap is hit', async () => {
    const config = makeConfig({ maxRebaseAttempts: 2 });
    const deps = makeDeps();
    const ledger = makeMemoryLedger();
    ledger.record('rebase-recreate-attempt', 'wf-8', '2');
    ledger.record('rebase-recreate-attempt', 'wf-8', '2');
    (deps.github.listOpenAuthoredPrs as Mock).mockResolvedValue([{ number: 8, mergeStateStatus: 'DIRTY' }]);
    (deps.owner.resolveWorkflowForPr as Mock).mockResolvedValue({ workflowId: 'wf-8', workflowGeneration: 2 });

    await runPrConflictRebaseTick({ config, deps, ledger, logger: makeLogger() });

    expect(deps.owner.dispatchRebaseRecreate).not.toHaveBeenCalled();
    expect(deps.github.postPrComment).toHaveBeenCalledTimes(1);
    expect(deps.github.postPrComment).toHaveBeenCalledWith('8', expect.stringContaining('manual attention'));
    expect(ledger.markerSeen('rebase-recreate-flagged', 'wf-8', 'exhausted')).toBe(true);
  });

  it('does not record the exhausted flag when the comment fails to post', async () => {
    const config = makeConfig({ maxRebaseAttempts: 1 });
    const deps = makeDeps();
    const ledger = makeMemoryLedger();
    ledger.record('rebase-recreate-attempt', 'wf-8', '2');
    (deps.github.listOpenAuthoredPrs as Mock).mockResolvedValue([{ number: 8, mergeStateStatus: 'DIRTY' }]);
    (deps.owner.resolveWorkflowForPr as Mock).mockResolvedValue({ workflowId: 'wf-8', workflowGeneration: 2 });
    (deps.github.postPrComment as Mock).mockResolvedValue(false);

    await runPrConflictRebaseTick({ config, deps, ledger, logger: makeLogger() });

    expect(ledger.markerSeen('rebase-recreate-flagged', 'wf-8', 'exhausted')).toBe(false);
  });

  it('skips when the review-gate lookup fails', async () => {
    const deps = makeDeps();
    (deps.github.listOpenAuthoredPrs as Mock).mockResolvedValue([{ number: 8, mergeStateStatus: 'DIRTY' }]);
    (deps.owner.resolveWorkflowForPr as Mock).mockResolvedValue(null);
    await runPrConflictRebaseTick({ config: makeConfig(), deps, ledger: makeMemoryLedger(), logger: makeLogger() });
    expect(deps.owner.dispatchRebaseRecreate).not.toHaveBeenCalled();
  });

  it('throws and records no attempt when the dispatch is rejected', async () => {
    const deps = makeDeps();
    const ledger = makeMemoryLedger();
    (deps.github.listOpenAuthoredPrs as Mock).mockResolvedValue([{ number: 8, mergeStateStatus: 'DIRTY' }]);
    (deps.owner.resolveWorkflowForPr as Mock).mockResolvedValue({ workflowId: 'wf-8', workflowGeneration: 2 });
    (deps.owner.dispatchRebaseRecreate as Mock).mockResolvedValue(false);

    await expect(runPrConflictRebaseTick({ config: makeConfig(), deps, ledger, logger: makeLogger() }))
      .rejects.toThrow(/dispatch failed/);
    expect(ledger.count('rebase-recreate-attempt', 'wf-8', '2')).toBe(0);
  });

  it('throws when the recreate is never confirmed within the timeout window', async () => {
    const config = makeConfig({ confirmTimeoutSeconds: 10 });
    const clock = makeClock(1_000);
    const deps = makeDeps(clock);
    const ledger = makeMemoryLedger();
    (deps.github.listOpenAuthoredPrs as Mock).mockResolvedValue([{ number: 8, mergeStateStatus: 'DIRTY' }]);
    (deps.owner.resolveWorkflowForPr as Mock).mockResolvedValue({ workflowId: 'wf-8', workflowGeneration: 2 });
    // Generation never advances past 2.
    (deps.owner.queryWorkflowGeneration as Mock).mockResolvedValue(2);

    await expect(runPrConflictRebaseTick({ config, deps, ledger, logger: makeLogger() }))
      .rejects.toThrow(/not confirmed/);
    // The accepted dispatch is still counted toward the cap.
    expect(ledger.count('rebase-recreate-attempt', 'wf-8', '2')).toBe(1);
    expect(ledger.markerSeen('rebase-recreate', 'wf-8', '2')).toBe(false);
  });

  it('processes at most one conflicting PR per tick', async () => {
    const deps = makeDeps();
    (deps.github.listOpenAuthoredPrs as Mock).mockResolvedValue([
      { number: 8, mergeStateStatus: 'DIRTY' },
      { number: 9, mergeable: 'CONFLICTING' },
    ]);
    (deps.owner.resolveWorkflowForPr as Mock)
      .mockResolvedValueOnce({ workflowId: 'wf-8', workflowGeneration: 1 });
    (deps.owner.queryWorkflowGeneration as Mock).mockResolvedValue(2);

    await runPrConflictRebaseTick({ config: makeConfig(), deps, ledger: makeMemoryLedger(), logger: makeLogger() });

    expect(deps.owner.dispatchRebaseRecreate).toHaveBeenCalledTimes(1);
    expect(deps.owner.dispatchRebaseRecreate).toHaveBeenCalledWith('wf-8');
  });

  it('in dry-run mode does not dispatch', async () => {
    const config = makeConfig({ dryRun: true });
    const deps = makeDeps();
    (deps.github.listOpenAuthoredPrs as Mock).mockResolvedValue([{ number: 8, mergeStateStatus: 'DIRTY' }]);
    (deps.owner.resolveWorkflowForPr as Mock).mockResolvedValue({ workflowId: 'wf-8', workflowGeneration: 2 });

    await runPrConflictRebaseTick({ config, deps, ledger: makeMemoryLedger(), logger: makeLogger() });

    expect(deps.owner.dispatchRebaseRecreate).not.toHaveBeenCalled();
  });
});

describe('resolvePrMaintenanceRuntime', () => {
  it('applies env overrides, sets the lock path, and reads tunables', () => {
    const resolved = resolvePrMaintenanceRuntime({
      repoRoot: '/srv/invoker',
      lockPath: '/var/lock/pr.lock',
      env: {
        INVOKER_GITHUB_TARGET_REPO: 'owner/repo',
        INVOKER_PR_CRON_AUTHOR: 'octocat',
        INVOKER_PR_CODERABBIT_MAX_ATTEMPTS: '5',
        INVOKER_PR_CRON_DRY_RUN: '1',
      },
    });

    expect(resolved.repoRoot).toBe('/srv/invoker');
    expect(resolved.env.INVOKER_REPO_ROOT).toBe('/srv/invoker');
    expect(resolved.env.INVOKER_PR_CRON_LOCK).toBe('/var/lock/pr.lock');
    expect(resolved.lockPath).toBe('/var/lock/pr.lock');
    expect(resolved.targetRepo).toBe('owner/repo');
    expect(resolved.prAuthor).toBe('octocat');
    expect(resolved.maxCoderabbitAttempts).toBe(5);
    expect(resolved.dryRun).toBe(true);
  });
});

describe('PR maintenance workers (runtime wiring)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('runs the native CodeRabbit backend directly (no shell child process)', async () => {
    const logger = makeLogger();
    const deps = makeDeps();
    (deps.github.listOpenAuthoredPrs as Mock).mockResolvedValue([
      { number: 42, headRefName: 'f', baseRefName: 'm', title: 't' },
    ]);
    (deps.github.collectCoderabbitComments as Mock).mockResolvedValue([
      { body: 'x', updated_at: '2024-01-03T00:00:00Z', path: null, html_url: null },
    ]);

    const worker = createCoderabbitAddressWorker({
      logger,
      repoRoot: '/repo',
      deps,
      ledger: makeMemoryLedger(),
      lock: () => ({ acquired: true, release: () => {} }),
      installSignalHandlers: false,
    });

    await worker.tick();

    expect(deps.omp.addressCoderabbitFeedback).toHaveBeenCalledTimes(1);
  });

  it('skips cleanly when the shared PR-maintenance lock is already held', async () => {
    const logger = makeLogger();
    const deps = makeDeps();
    const worker = createPrConflictRebaseWorker({
      logger,
      repoRoot: '/repo',
      deps,
      ledger: makeMemoryLedger(),
      lock: () => ({ acquired: false, reason: 'test-lock-held' }),
      installSignalHandlers: false,
    });

    await worker.tick();

    expect(deps.github.listOpenAuthoredPrs).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      `[worker:${PR_CONFLICT_REBASE_WORKER_KIND}] shared PR maintenance lock held; skipping tick`,
      expect.objectContaining({ worker: PR_CONFLICT_REBASE_WORKER_KIND, reason: 'test-lock-held' }),
    );
  });

  it('releases the lock even when the backend tick throws', async () => {
    const release = vi.fn();
    const deps = makeDeps();
    (deps.github.listOpenAuthoredPrs as Mock).mockResolvedValue([{ number: 8, mergeStateStatus: 'DIRTY' }]);
    (deps.owner.resolveWorkflowForPr as Mock).mockResolvedValue({ workflowId: 'wf-8', workflowGeneration: 2 });
    (deps.owner.dispatchRebaseRecreate as Mock).mockResolvedValue(false);

    const worker = createPrConflictRebaseWorker({
      logger: makeLogger(),
      repoRoot: '/repo',
      deps,
      ledger: makeMemoryLedger(),
      lock: () => ({ acquired: true, release }),
      installSignalHandlers: false,
    });

    // The worker runtime swallows and logs a throwing tick; the lock must still release.
    await worker.tick();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('polls on the five-minute default interval without ticking on start', async () => {
    vi.useFakeTimers();
    const logger = makeLogger();
    const deps = makeDeps();
    const worker = createCoderabbitAddressWorker({
      logger,
      repoRoot: '/repo',
      deps,
      ledger: makeMemoryLedger(),
      lock: () => ({ acquired: true, release: () => {} }),
      installSignalHandlers: false,
    });

    worker.start();
    expect(deps.github.listOpenAuthoredPrs).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEFAULT_PR_MAINTENANCE_WORKER_INTERVAL_MS - 1);
    expect(deps.github.listOpenAuthoredPrs).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(deps.github.listOpenAuthoredPrs).toHaveBeenCalledTimes(1);
    await worker.stop();
  });

  it('exposes both worker kinds', () => {
    expect(CODERABBIT_ADDRESS_WORKER_KIND).toBe('coderabbit-address');
    expect(PR_CONFLICT_REBASE_WORKER_KIND).toBe('pr-conflict-rebase');
  });
});
