import { describe, it, expect, vi } from 'vitest';
import type { Logger } from '@invoker/contracts';
import {
  AUTO_FIX_WORKER_KIND,
  DEFAULT_AUTO_FIX_ATTEMPT_BUDGET,
  createWorkerRegistry,
  registerAutoFixWorker,
  type WorkerFactoryDeps,
} from '../worker-registry.js';
import { RECOVERY_WORKER_KIND } from '../worker-runtime.js';

function createMockLogger(): Logger {
  const child = vi.fn();
  const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child };
  child.mockReturnValue(logger);
  return logger;
}

function createFactoryDeps(): WorkerFactoryDeps {
  return {
    state: { read: () => undefined, write: () => undefined },
    actionOutput: { emit: vi.fn() },
    logger: createMockLogger(),
    autoFix: { attemptBudget: DEFAULT_AUTO_FIX_ATTEMPT_BUDGET, agent: 'claude' },
  };
}

describe('worker registry', () => {
  it('starts empty: no definitions and no lookup hits', () => {
    const registry = createWorkerRegistry();
    expect(registry.list()).toEqual([]);
    expect(registry.get(AUTO_FIX_WORKER_KIND)).toBeUndefined();
  });

  it('returns the autofix definition by its kind once the built-in is registered', () => {
    const registry = registerAutoFixWorker(createWorkerRegistry());

    const definition = registry.get(AUTO_FIX_WORKER_KIND);
    expect(definition).toBeDefined();
    expect(definition?.kind).toBe(AUTO_FIX_WORKER_KIND);
    // The operator-facing note is non-empty so it can be surfaced in output.
    expect(definition?.note.length).toBeGreaterThan(0);
  });

  it('returns nothing for an unknown kind', () => {
    const registry = registerAutoFixWorker(createWorkerRegistry());
    expect(registry.get('does-not-exist')).toBeUndefined();
  });

  it('lists exactly the built-in autofix definition', () => {
    const registry = registerAutoFixWorker(createWorkerRegistry());
    const kinds = registry.list().map((definition) => definition.kind);
    expect(kinds).toEqual([AUTO_FIX_WORKER_KIND]);
  });

  it('builds the auto-fix recovery worker from injected dependencies', async () => {
    const registry = registerAutoFixWorker(createWorkerRegistry());
    const definition = registry.get(AUTO_FIX_WORKER_KIND);
    expect(definition).toBeDefined();

    const worker = definition!.factory(createFactoryDeps());
    // Reuses the recovery worker engine: the runtime carries the recovery kind.
    expect(worker.identity.kind).toBe(RECOVERY_WORKER_KIND);
    // Behavior-neutral: its default tick is a no-op and never throws.
    await expect(worker.tick()).resolves.toBeUndefined();
    await worker.stop();
  });

  it('register replaces an earlier definition for the same kind', () => {
    const registry = createWorkerRegistry();
    const first = { kind: AUTO_FIX_WORKER_KIND, note: 'first', factory: vi.fn() };
    const second = { kind: AUTO_FIX_WORKER_KIND, note: 'second', factory: vi.fn() };
    registry.register(first);
    registry.register(second);
    expect(registry.get(AUTO_FIX_WORKER_KIND)).toBe(second);
    expect(registry.list()).toHaveLength(1);
  });
});
