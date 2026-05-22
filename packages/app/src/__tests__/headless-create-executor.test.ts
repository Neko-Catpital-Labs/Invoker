/**
 * CB.7 acceptance: verifies createHeadlessExecutor's active-mode
 * short-circuit. In `INVOKER_LAUNCH_OUTBOX=active` mode the owner's
 * long-lived TaskRunner is the single launch path (it services the
 * task_launch_dispatch outbox via LaunchDispatcher), so headless
 * commands must reuse it instead of constructing a per-command
 * TaskRunner — that was the root of Issue 6 (multi-TaskRunner
 * blindness from per-instance `launchingAttemptIds` Sets).
 */
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@invoker/contracts';
import type { TaskRunner } from '@invoker/execution-engine';
import { createHeadlessExecutor, type HeadlessDeps } from '../headless.js';

function makeLogger(): Logger & {
  records: { level: 'info' | 'warn' | 'error' | 'debug'; msg: string }[];
} {
  const records: { level: 'info' | 'warn' | 'error' | 'debug'; msg: string }[] = [];
  const push =
    (level: 'info' | 'warn' | 'error' | 'debug') =>
    (msg: string) => {
      records.push({ level, msg });
    };
  const logger: Logger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => logger,
  };
  return Object.assign(logger, { records });
}

function fakeOwnerTaskRunner(): TaskRunner {
  return { kind: 'owner-runner' } as unknown as TaskRunner;
}

function makeDeps(overrides: Partial<HeadlessDeps>): HeadlessDeps {
  return {
    logger: makeLogger(),
    orchestrator: {} as any,
    persistence: {
      appendTaskOutput: vi.fn(),
    } as any,
    executorRegistry: {} as any,
    messageBus: {} as any,
    commandService: {} as any,
    repoRoot: '/tmp/repo',
    invokerConfig: {
      launchOutboxMode: 'disabled',
      defaultBranch: 'main',
      docker: {},
      executionPools: {},
      remoteTargets: {},
    } as any,
    initServices: async () => {},
    wireSlackBot: async () => ({}),
    ...overrides,
  };
}

describe('createHeadlessExecutor (CB.7 active-mode short-circuit)', () => {
  it('returns the owner TaskRunner when launchOutboxMode=active and the provider yields one', () => {
    const owner = fakeOwnerTaskRunner();
    const deps = makeDeps({
      invokerConfig: {
        launchOutboxMode: 'active',
        defaultBranch: 'main',
        docker: {},
        executionPools: {},
        remoteTargets: {},
      } as any,
      ownerTaskRunnerProvider: () => owner,
    });

    const executor = createHeadlessExecutor(deps);
    expect(executor).toBe(owner);
  });

  it('logs a debug note and still returns the owner when callbackOverrides are passed (overrides are ignored)', () => {
    const owner = fakeOwnerTaskRunner();
    const logger = makeLogger();
    const deps = makeDeps({
      logger,
      invokerConfig: {
        launchOutboxMode: 'active',
        defaultBranch: 'main',
        docker: {},
        executionPools: {},
        remoteTargets: {},
      } as any,
      ownerTaskRunnerProvider: () => owner,
    });

    const executor = createHeadlessExecutor(deps, { onOutput: () => {} });
    expect(executor).toBe(owner);
    const debugRecord = logger.records.find(
      (r) => r.level === 'debug' && r.msg.includes('ignoring callbackOverrides'),
    );
    expect(debugRecord).toBeDefined();
  });

  it('warns and falls back to constructing a fresh TaskRunner when active but no owner is available', () => {
    const logger = makeLogger();
    const deps = makeDeps({
      logger,
      invokerConfig: {
        launchOutboxMode: 'active',
        defaultBranch: 'main',
        docker: {},
        executionPools: {},
        remoteTargets: {},
      } as any,
      // No ownerTaskRunnerProvider — simulates a true standalone owner
      // that hasn't initialised its TaskRunner yet.
    });

    // The constructor of TaskRunner requires real shared services to
    // succeed; for this test we only care that the active branch took
    // the fallback path (warning emitted) before any throw. We catch
    // any constructor-time error so we can assert on the warning
    // independently.
    let threw = false;
    try {
      createHeadlessExecutor(deps);
    } catch {
      threw = true;
    }
    void threw; // either outcome is acceptable for this assertion
    const warn = logger.records.find(
      (r) => r.level === 'warn' && r.msg.includes('ownerTaskRunnerProvider is unavailable'),
    );
    expect(warn).toBeDefined();
  });

  it('does not short-circuit when launchOutboxMode is not active', () => {
    const owner = fakeOwnerTaskRunner();
    const providerCalls = vi.fn(() => owner);
    const deps = makeDeps({
      invokerConfig: {
        launchOutboxMode: 'observe',
        defaultBranch: 'main',
        docker: {},
        executionPools: {},
        remoteTargets: {},
      } as any,
      ownerTaskRunnerProvider: providerCalls,
    });

    // We expect a real TaskRunner construction to fail in this minimal
    // env; that's fine — what we're asserting is that the provider was
    // *not* consulted (the legacy code path was taken).
    try {
      createHeadlessExecutor(deps);
    } catch {
      // swallow — verifying the provider call below
    }
    expect(providerCalls).not.toHaveBeenCalled();
  });
});
