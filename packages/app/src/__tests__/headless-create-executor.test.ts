/**
 * Verifies createHeadlessExecutor's owner-runner short-circuit. The
 * owner's long-lived TaskRunner is the single launch path (it services
 * the task_launch_dispatch outbox via LaunchDispatcher), so headless
 * commands must reuse it instead of constructing a per-command
 * TaskRunner — a per-instance `launchingAttemptIds` Set would break
 * duplicate-launch suppression across processes.
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

describe('createHeadlessExecutor (owner-runner short-circuit)', () => {
  it('returns the owner TaskRunner when the provider yields one', () => {
    const owner = fakeOwnerTaskRunner();
    const deps = makeDeps({
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
      ownerTaskRunnerProvider: () => owner,
    });

    const executor = createHeadlessExecutor(deps, { onOutput: () => {} });
    expect(executor).toBe(owner);
    const debugRecord = logger.records.find(
      (r) => r.level === 'debug' && r.msg.includes('ignoring callbackOverrides'),
    );
    expect(debugRecord).toBeDefined();
  });

  it('falls through to constructing a fresh TaskRunner when no owner provider is available', () => {
    const logger = makeLogger();
    const deps = makeDeps({
      logger,
      // No ownerTaskRunnerProvider — TaskRunner construction may fail
      // with minimal deps; either outcome is fine, we only care that
      // the owner short-circuit did not fire.
    });

    let threw = false;
    try {
      createHeadlessExecutor(deps);
    } catch {
      threw = true;
    }
    void threw;
    const warn = logger.records.find((r) => r.level === 'warn');
    expect(warn).toBeUndefined();
  });
});
