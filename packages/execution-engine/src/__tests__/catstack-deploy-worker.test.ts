import { describe, expect, it, vi } from 'vitest';

import {
  buildCatstackDeployScript,
  createCatstackDeployWorker,
  DEFAULT_CATSTACK_DEPLOY_INTERVAL_MS,
  DEFAULT_CATSTACK_REPO_PATH,
  DEFAULT_CATSTACK_REPO_URL,
  expandLocalRepoPath,
  runCatstackDeployTick,
  type CatstackDeployTarget,
  type CatstackDeployWorkerOptions,
} from '../workers/catstack-deploy-worker.js';
import type { WorkerDecisionStore } from '../worker-decision-ledger.js';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as CatstackDeployWorkerOptions['logger'];
}

function makeTarget(name: string): CatstackDeployTarget {
  return {
    name,
    connection: { host: `${name}.example.test`, user: 'invoker', sshKeyPath: '/tmp/key' },
  };
}

function makeStore(): { store: WorkerDecisionStore; rows: { subjectId: string; status: string }[] } {
  const rows: { subjectId: string; status: string }[] = [];
  return {
    rows,
    store: {
      getWorkerAction: () => undefined,
      upsertWorkerAction: (action) => {
        rows.push({ subjectId: action.subjectId, status: action.status });
        return action as never;
      },
    },
  };
}

describe('buildCatstackDeployScript', () => {
  it('clones when missing, ff-only pulls when present, and runs install.sh without --force', () => {
    const script = buildCatstackDeployScript('~/Documents/GitHub/catstack', DEFAULT_CATSTACK_REPO_URL);
    expect(script).toContain('git clone');
    expect(script).toContain('git merge --ff-only');
    expect(script).toContain('./install.sh');
    expect(script).not.toMatch(/\.\/install\.sh[^\n]*--force/);
    expect(script).not.toContain('--with-session-mine');
    expect(script).not.toContain('--with-dora-snapshot');
    expect(script).toContain('git status --porcelain');
  });
});

describe('expandLocalRepoPath', () => {
  it('expands a leading tilde', () => {
    const expanded = expandLocalRepoPath('~/Documents/GitHub/catstack');
    expect(expanded.endsWith('/Documents/GitHub/catstack')).toBe(true);
    expect(expanded.startsWith('~')).toBe(false);
  });
});

describe('runCatstackDeployTick', () => {
  it('deploys local then every remote target', async () => {
    const deployLocal = vi.fn(async () => undefined);
    const deployRemote = vi.fn(async () => undefined);
    const { store, rows } = makeStore();

    await runCatstackDeployTick({
      logger: makeLogger(),
      repoUrl: DEFAULT_CATSTACK_REPO_URL,
      localRepoPath: DEFAULT_CATSTACK_REPO_PATH,
      remoteRepoPath: DEFAULT_CATSTACK_REPO_PATH,
      remoteTargets: [makeTarget('do1'), makeTarget('do2')],
      store,
      deployLocal,
      deployRemote,
    });

    expect(deployLocal).toHaveBeenCalledTimes(1);
    expect(deployLocal.mock.calls[0]?.[1]).toBe(DEFAULT_CATSTACK_REPO_URL);
    expect(deployRemote).toHaveBeenCalledTimes(2);
    expect(rows.map((r) => r.subjectId)).toEqual(['local', 'do1', 'do2']);
    expect(rows.every((r) => r.status === 'completed')).toBe(true);
  });

  it('continues remaining hosts when local or a remote fails, and skips install on that host only via the deploy seam', async () => {
    const deployLocal = vi.fn(async () => {
      throw new Error('dirty working tree');
    });
    const deployRemote = vi.fn(async (target) => {
      if (target.name === 'do1') throw new Error('merge --ff-only rejected');
    });
    const { store, rows } = makeStore();

    await runCatstackDeployTick({
      logger: makeLogger(),
      repoUrl: DEFAULT_CATSTACK_REPO_URL,
      localRepoPath: '/tmp/catstack',
      remoteRepoPath: '~/Documents/GitHub/catstack',
      remoteTargets: [makeTarget('do1'), makeTarget('do2')],
      store,
      deployLocal,
      deployRemote,
    });

    expect(deployLocal).toHaveBeenCalledTimes(1);
    expect(deployRemote).toHaveBeenCalledTimes(2);
    const statuses = Object.fromEntries(rows.map((r) => [r.subjectId, r.status]));
    expect(statuses).toEqual({
      local: 'failed',
      do1: 'failed',
      do2: 'completed',
    });
  });

  it('passes expanded local path and configured remote path to deploy seams', async () => {
    const deployLocal = vi.fn(async () => undefined);
    const deployRemote = vi.fn(async () => undefined);

    await runCatstackDeployTick({
      logger: makeLogger(),
      repoUrl: 'https://github.com/EdbertChan/catstack.git',
      localRepoPath: '~/Documents/GitHub/catstack',
      remoteRepoPath: '~/Documents/GitHub/catstack',
      remoteTargets: [makeTarget('do1')],
      deployLocal,
      deployRemote,
    });

    expect(deployLocal.mock.calls[0]?.[0]).toBe(expandLocalRepoPath('~/Documents/GitHub/catstack'));
    expect(deployRemote.mock.calls[0]?.[1]).toBe('~/Documents/GitHub/catstack');
  });
});

describe('createCatstackDeployWorker', () => {
  it('uses the default fifteen-minute interval', () => {
    const worker = createCatstackDeployWorker({
      logger: makeLogger(),
      onTick: async () => undefined,
      tickOnStart: false,
    });
    expect(worker.identity.kind).toBe('catstack-deploy');
    expect(DEFAULT_CATSTACK_DEPLOY_INTERVAL_MS).toBe(15 * 60 * 1000);
    worker.stop();
  });
});
