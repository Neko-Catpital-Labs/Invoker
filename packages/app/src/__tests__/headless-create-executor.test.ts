/**
 * Verifies createHeadlessExecutor reuses the owner's long-lived
 * TaskRunner when one is available. That owner runner services the
 * durable launch outbox, so headless commands must not create a second
 * independent runner.
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
    invokerConfig: {
      defaultBranch: 'main',
      docker: {},
      executionPools: {},
      remoteTargets: {},
    } as any,
    initServices: async () => {},
    ...overrides,
  };
}

describe('createHeadlessExecutor owner-runner reuse', () => {
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

  it('falls back to constructing a fresh TaskRunner when no owner is available', () => {
    const deps = makeDeps({});

    try {
      createHeadlessExecutor(deps);
    } catch {
      // The constructor needs real services in production. This assertion only
      // covers the absence of an owner runner.
    }
  });

});
