import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageBus } from '@invoker/transport';
import { LocalBus } from '@invoker/transport';

const { createDeleteAllSnapshotMock } = vi.hoisted(() => ({
  createDeleteAllSnapshotMock: vi.fn(() => '/tmp/invoker/db-backups/invoker.db.before-delete-all-test'),
}));

vi.mock('../delete-all-snapshot.js', () => ({
  createDeleteAllSnapshot: createDeleteAllSnapshotMock,
}));

function makeDeps() {
  return {
    orchestrator: {
      deleteAllWorkflows: vi.fn(),
    },
    persistence: {
      readOnly: false,
      listWorkflows: vi.fn(() => []),
      loadTasks: vi.fn(() => []),
    },
    familiarRegistry: {},
    messageBus: new LocalBus() as MessageBus,
    repoRoot: '/fake/repo',
    invokerConfig: {},
    initServices: vi.fn(async () => {}),
    wireSlackBot: vi.fn(async () => ({})),
  } as any;
}

describe('headless delete-all safety', () => {
  beforeEach(() => {
    createDeleteAllSnapshotMock.mockClear();
    delete process.env.INVOKER_ALLOW_DELETE_ALL;
  });

  it('rejects delete-all when opt-in env is missing', async () => {
    vi.resetModules();
    const { runHeadless } = await import('../headless.js');
    const deps = makeDeps();

    await expect(runHeadless(['delete-all'], deps)).rejects.toThrow(
      /INVOKER_ALLOW_DELETE_ALL=1/,
    );
    expect(createDeleteAllSnapshotMock).not.toHaveBeenCalled();
    expect(deps.orchestrator.deleteAllWorkflows).not.toHaveBeenCalled();
  });

  it('creates snapshot before deleting all workflows when opt-in is enabled', async () => {
    process.env.INVOKER_ALLOW_DELETE_ALL = '1';
    vi.resetModules();
    const { runHeadless } = await import('../headless.js');
    const deps = makeDeps();

    await expect(runHeadless(['delete-all'], deps)).resolves.toBeUndefined();
    expect(createDeleteAllSnapshotMock).toHaveBeenCalledTimes(1);
    expect(deps.orchestrator.deleteAllWorkflows).toHaveBeenCalledTimes(1);
  });
});
