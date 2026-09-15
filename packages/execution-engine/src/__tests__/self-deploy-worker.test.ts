import { describe, expect, it, vi } from 'vitest';

import {
  createSelfDeployWorker,
  DEFAULT_SELF_DEPLOY_INTERVAL_MS,
  runSelfDeployTick,
  SELF_DEPLOY_WORKER_KIND,
  type SelfDeployWorkerOptions,
  type SelfDeployWorkerStore,
} from '../workers/self-deploy-worker.js';
import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as SelfDeployWorkerOptions['logger'];
}

function makeTask(status: TaskState['status']): TaskState {
  return { status } as unknown as TaskState;
}

function makeStore(options: {
  workflows?: Array<{ id: string; tasks: TaskState[] }>;
} = {}): { store: SelfDeployWorkerStore; rows: WorkerActionWrite[] } {
  const workflows = options.workflows ?? [];
  const rows: WorkerActionWrite[] = [];
  const byExternalKey = new Map<string, WorkerActionRecord>();
  return {
    rows,
    store: {
      listWorkflows: () => workflows.map((workflow) => ({ id: workflow.id })),
      loadTasks: (workflowId) => workflows.find((workflow) => workflow.id === workflowId)?.tasks ?? [],
      getWorkerAction: (workerKind, externalKey) => byExternalKey.get(`${workerKind}:${externalKey}`),
      upsertWorkerAction: (action) => {
        rows.push(action);
        const record: WorkerActionRecord = {
          ...action,
          attemptCount: action.attemptCount ?? 0,
          createdAt: action.updatedAt ?? new Date().toISOString(),
          updatedAt: action.updatedAt ?? new Date().toISOString(),
        };
        byExternalKey.set(`${action.workerKind}:${action.externalKey}`, record);
        return record;
      },
    },
  };
}

function baseOptions(overrides: Partial<SelfDeployWorkerOptions> = {}): SelfDeployWorkerOptions {
  return {
    logger: makeLogger(),
    repoPath: '/tmp/invoker-do1',
    remoteName: 'upstream',
    branchName: 'master',
    deployScriptPath: 'scripts/deploy-do1.sh',
    ...overrides,
  };
}

describe('runSelfDeployTick', () => {
  it('deploys when upstream/master moved and no tasks are running', async () => {
    const getRemoteHeadSha = vi.fn(async () => 'sha-new');
    const runDeploy = vi.fn(async () => undefined);
    const { store, rows } = makeStore();

    await runSelfDeployTick(baseOptions({
      store,
      getRemoteHeadSha,
      runDeploy,
      hasRunningTasks: () => false,
    }));

    expect(getRemoteHeadSha).toHaveBeenCalledWith('/tmp/invoker-do1', 'upstream', 'master');
    expect(runDeploy).toHaveBeenCalledWith('scripts/deploy-do1.sh');
    expect(runDeploy).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('completed');
    expect(rows[0]?.payload).toEqual({ deployedSha: 'sha-new' });
  });

  it('skips the deploy and never invokes it when DO1 has active running tasks', async () => {
    const getRemoteHeadSha = vi.fn(async () => 'sha-new');
    const runDeploy = vi.fn(async () => undefined);
    const { store, rows } = makeStore();

    await runSelfDeployTick(baseOptions({
      store,
      getRemoteHeadSha,
      runDeploy,
      hasRunningTasks: () => true,
    }));

    expect(runDeploy).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('skipped');
    expect(rows[0]?.summary).toMatch(/active running tasks/);
  });

  it('derives the running-tasks check from the store when no seam is given, and skips on a running task', async () => {
    const getRemoteHeadSha = vi.fn(async () => 'sha-new');
    const runDeploy = vi.fn(async () => undefined);
    const { store } = makeStore({
      workflows: [{ id: 'wf-1', tasks: [makeTask('running')] }],
    });

    await runSelfDeployTick(baseOptions({ store, getRemoteHeadSha, runDeploy }));

    expect(runDeploy).not.toHaveBeenCalled();
  });

  it('deploys via the store-derived check when every task is inactive', async () => {
    const getRemoteHeadSha = vi.fn(async () => 'sha-new');
    const runDeploy = vi.fn(async () => undefined);
    const { store } = makeStore({
      workflows: [{ id: 'wf-1', tasks: [makeTask('completed'), makeTask('failed')] }],
    });

    await runSelfDeployTick(baseOptions({ store, getRemoteHeadSha, runDeploy }));

    expect(runDeploy).toHaveBeenCalledTimes(1);
  });

  it('does nothing when upstream/master is unchanged since the last completed deploy', async () => {
    const { store, rows } = makeStore();
    const getRemoteHeadSha = vi.fn(async () => 'sha-current');
    const runDeploy = vi.fn(async () => undefined);

    await runSelfDeployTick(baseOptions({
      store,
      getRemoteHeadSha,
      runDeploy,
      hasRunningTasks: () => false,
    }));
    expect(runDeploy).toHaveBeenCalledTimes(1);

    await runSelfDeployTick(baseOptions({
      store,
      getRemoteHeadSha,
      runDeploy,
      hasRunningTasks: () => false,
    }));

    expect(runDeploy).toHaveBeenCalledTimes(1);
    expect(rows.filter((row) => row.status === 'completed')).toHaveLength(1);
  });

  it('retries on the next tick after a failed deploy instead of recording it as deployed', async () => {
    const { store, rows } = makeStore();
    const getRemoteHeadSha = vi.fn(async () => 'sha-broken');
    const runDeploy = vi.fn(async () => {
      throw new Error('deploy script exited 1');
    });

    await runSelfDeployTick(baseOptions({
      store,
      getRemoteHeadSha,
      runDeploy,
      hasRunningTasks: () => false,
    }));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.payload).toEqual({});

    const runDeployRetry = vi.fn(async () => undefined);
    await runSelfDeployTick(baseOptions({
      store,
      getRemoteHeadSha,
      runDeploy: runDeployRetry,
      hasRunningTasks: () => false,
    }));

    expect(runDeployRetry).toHaveBeenCalledTimes(1);
  });

  it('carries the last deployed sha forward across a skip so a later tick still deploys once', async () => {
    const { store, rows } = makeStore();
    const getRemoteHeadShaV1 = vi.fn(async () => 'sha-v1');
    await runSelfDeployTick(baseOptions({
      store,
      getRemoteHeadSha: getRemoteHeadShaV1,
      runDeploy: vi.fn(async () => undefined),
      hasRunningTasks: () => false,
    }));

    const getRemoteHeadShaV2 = vi.fn(async () => 'sha-v2');
    const runDeploySkipped = vi.fn(async () => undefined);
    await runSelfDeployTick(baseOptions({
      store,
      getRemoteHeadSha: getRemoteHeadShaV2,
      runDeploy: runDeploySkipped,
      hasRunningTasks: () => true,
    }));
    expect(runDeploySkipped).not.toHaveBeenCalled();

    const runDeployFinal = vi.fn(async () => undefined);
    await runSelfDeployTick(baseOptions({
      store,
      getRemoteHeadSha: getRemoteHeadShaV2,
      runDeploy: runDeployFinal,
      hasRunningTasks: () => false,
    }));

    expect(runDeployFinal).toHaveBeenCalledTimes(1);
    expect(rows.filter((row) => row.status === 'completed').map((row) => row.payload)).toEqual([
      { deployedSha: 'sha-v1' },
      { deployedSha: 'sha-v2' },
    ]);
  });

  it('skips for safety and never deploys when the remote head sha cannot be resolved', async () => {
    const { store, rows } = makeStore();
    const runDeploy = vi.fn(async () => undefined);

    await runSelfDeployTick(baseOptions({
      store,
      getRemoteHeadSha: vi.fn(async () => {
        throw new Error('git fetch failed');
      }),
      runDeploy,
      hasRunningTasks: () => false,
    }));

    expect(runDeploy).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('failed');
  });

  it('skips for safety and never deploys when the running-tasks check itself throws', async () => {
    const { store, rows } = makeStore();
    const runDeploy = vi.fn(async () => undefined);

    await runSelfDeployTick(baseOptions({
      store,
      getRemoteHeadSha: vi.fn(async () => 'sha-new'),
      runDeploy,
      hasRunningTasks: () => {
        throw new Error('query surface unavailable');
      },
    }));

    expect(runDeploy).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('skipped');
  });
});

describe('createSelfDeployWorker', () => {
  it('uses the default thirty-minute interval and the self-deploy kind', () => {
    const worker = createSelfDeployWorker({
      logger: makeLogger(),
      onTick: async () => undefined,
      tickOnStart: false,
    });
    expect(worker.identity.kind).toBe(SELF_DEPLOY_WORKER_KIND);
    expect(DEFAULT_SELF_DEPLOY_INTERVAL_MS).toBe(30 * 60 * 1000);
    worker.stop();
  });
});
