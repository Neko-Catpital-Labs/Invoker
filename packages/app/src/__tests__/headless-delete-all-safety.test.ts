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
    executorRegistry: {},
    messageBus: new LocalBus() as MessageBus,
    repoRoot: '/fake/repo',
    invokerConfig: {},
    initServices: vi.fn(async () => {}),
  } as any;
}

describe('headless delete-all safety', () => {
  beforeEach(() => {
    createDeleteAllSnapshotMock.mockClear();
  });

  it('creates a snapshot before deleting all workflows', async () => {
    vi.resetModules();
    const { runHeadless } = await import('../headless.js');
    const deps = makeDeps();

    await expect(runHeadless(['delete-all'], deps)).resolves.toBeUndefined();
    expect(createDeleteAllSnapshotMock).toHaveBeenCalledTimes(1);
    expect(deps.orchestrator.deleteAllWorkflows).toHaveBeenCalledTimes(1);
  });
});
