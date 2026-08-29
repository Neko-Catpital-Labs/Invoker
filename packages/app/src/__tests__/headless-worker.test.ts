import { describe, expect, it, vi } from 'vitest';
import { E2E_AUTOFIX_WORKER_KIND, INFRA_REPAIR_WORKER_KIND } from '@invoker/execution-engine';
import {
  resolveHeadlessDiskHeadroomConfig,
  resolveHeadlessInfraRepairConfig,
  resolveHeadlessCatstackDeployConfig,
  runHeadless,
} from '../headless.js';

describe('headless worker registry', () => {
  it('lists the registered owner worker kinds', async () => {
    let stdout = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });

    try {
      await runHeadless(['worker', 'list'], { invokerConfig: {} } as never);
    } finally {
      write.mockRestore();
    }

    expect(stdout).toContain('Worker kinds');
    expect(stdout).not.toContain('pr-summary-refresh');
    expect(stdout).toContain(INFRA_REPAIR_WORKER_KIND);
    expect(stdout).toContain('admin-bypass-e2e-babysit');
  });

  it('maps configured SSH targets into disk-headroom worker dependencies', () => {
    const config = resolveHeadlessDiskHeadroomConfig({
      remoteTargets: {
        digitalOcean: {
          host: '203.0.113.10',
          user: 'invoker',
          sshKeyPath: '/tmp/test-key',
          port: 2222,
        },
      },
    });

    expect(config.remoteTargets).toEqual([{
      name: 'digitalOcean',
      connection: {
        host: '203.0.113.10',
        user: 'invoker',
        sshKeyPath: '/tmp/test-key',
        port: 2222,
      },
      remotePath: '~/.invoker',
    }]);
  });

  it('uses a target\'s remoteInvokerHome as the remotePath when set', () => {
    const config = resolveHeadlessDiskHeadroomConfig({
      remoteTargets: {
        digitalOcean: {
          host: '203.0.113.10',
          user: 'invoker',
          sshKeyPath: '/tmp/test-key',
          port: 2222,
          remoteInvokerHome: '~/.invoker-custom',
        },
      },
    });

    expect(config.remoteTargets).toEqual([{
      name: 'digitalOcean',
      connection: {
        host: '203.0.113.10',
        user: 'invoker',
        sshKeyPath: '/tmp/test-key',
        port: 2222,
      },
      remotePath: '~/.invoker-custom',
    }]);
  });

  it('maps configured SSH targets into infra-repair worker dependencies', () => {
    const config = resolveHeadlessInfraRepairConfig({
      remoteTargets: {
        digitalOcean: {
          host: '203.0.113.10',
          user: 'invoker',
          sshKeyPath: '/tmp/test-key',
          port: 2222,
          provisionCommand: 'bash scripts/provision-ssh-worker.sh ensure-repo-ready',
          remoteInvokerHome: '~/.invoker-custom',
        },
      },
    }, '/tmp/repo-root');

    expect(config).toEqual({
      ownerRepoRoot: '/tmp/repo-root',
      ownerInvokerHome: expect.any(String),
      remoteTargets: {
        digitalOcean: {
          host: '203.0.113.10',
          user: 'invoker',
          sshKeyPath: '/tmp/test-key',
          port: 2222,
          provisionCommand: 'bash scripts/provision-ssh-worker.sh ensure-repo-ready',
          remoteInvokerHome: '~/.invoker-custom',
        },
      },
    });
  });

  it('maps configured SSH targets and intervalMinutes into catstack-deploy worker dependencies', () => {
    const config = resolveHeadlessCatstackDeployConfig({
      catstackDeploy: {
        intervalMinutes: 30,
        repoUrl: 'https://github.com/EdbertChan/catstack.git',
        localRepoPath: '~/Documents/GitHub/catstack',
        remoteRepoPath: '~/src/catstack',
      },
      remoteTargets: {
        digitalOcean: {
          host: '203.0.113.10',
          user: 'invoker',
          sshKeyPath: '/tmp/test-key',
          port: 2222,
        },
      },
    });

    expect(config).toEqual({
      intervalMs: 30 * 60_000,
      repoUrl: 'https://github.com/EdbertChan/catstack.git',
      localRepoPath: '~/Documents/GitHub/catstack',
      remoteRepoPath: '~/src/catstack',
      remoteTargets: [{
        name: 'digitalOcean',
        connection: {
          host: '203.0.113.10',
          user: 'invoker',
          sshKeyPath: '/tmp/test-key',
          port: 2222,
        },
      }],
    });
  });

  it('defaults catstack-deploy interval to 15 minutes when config is omitted', () => {
    const config = resolveHeadlessCatstackDeployConfig({});
    expect(config.intervalMs).toBe(15 * 60_000);
    expect(config.remoteTargets).toEqual([]);
  });
});

describe('headless worker start/stop', () => {
  // Incident 2026-08-13: `--headless worker stop <kind>` was documented (see
  // docs/remote-ssh-targets.md) and had a full delegation implementation in
  // headless-client.ts, but nothing in the actual runtime dispatch
  // (runHeadless -> headlessWorker) ever called it -- "start"/"stop" fell
  // through to the single-kind manual-tick branch, which rejected them as
  // unknown worker kinds. `invoker-ui --headless worker stop e2e-autofix`
  // failed with `Unknown worker kind: "stop"` against a live owner.
  it('stops a live worker via the owner worker runtime controller', async () => {
    let stdout = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });

    const stop = vi.fn().mockResolvedValue({ desiredEnabled: false });
    const start = vi.fn();

    try {
      await runHeadless(['worker', 'stop', E2E_AUTOFIX_WORKER_KIND], {
        invokerConfig: {},
        getWorkerRuntimeController: () => ({ start, stop } as never),
      } as never);
    } finally {
      write.mockRestore();
    }

    expect(stop).toHaveBeenCalledWith(E2E_AUTOFIX_WORKER_KIND);
    expect(start).not.toHaveBeenCalled();
    expect(stdout).toContain(`${E2E_AUTOFIX_WORKER_KIND}: stopped`);
  });

  it('starts a live worker via the owner worker runtime controller', async () => {
    let stdout = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });

    const start = vi.fn().mockReturnValue({ desiredEnabled: true });

    try {
      await runHeadless(['worker', 'start', E2E_AUTOFIX_WORKER_KIND], {
        invokerConfig: {},
        getWorkerRuntimeController: () => ({ start, stop: vi.fn() } as never),
      } as never);
    } finally {
      write.mockRestore();
    }

    expect(start).toHaveBeenCalledWith(E2E_AUTOFIX_WORKER_KIND);
    expect(stdout).toContain(`${E2E_AUTOFIX_WORKER_KIND}: started`);
  });

  it('rejects an unknown worker kind instead of silently no-opping', async () => {
    await expect(runHeadless(['worker', 'stop', 'not-a-real-kind'], {
      invokerConfig: {},
      getWorkerRuntimeController: () => ({ start: vi.fn(), stop: vi.fn() } as never),
    } as never)).rejects.toThrow(/Unknown worker kind: "not-a-real-kind"/);
  });

  it('fails clearly when run outside a live owner process, instead of a confusing "unknown worker kind"', async () => {
    await expect(runHeadless(['worker', 'stop', E2E_AUTOFIX_WORKER_KIND], {
      invokerConfig: {},
      getWorkerRuntimeController: () => null,
    } as never)).rejects.toThrow(/no live owner worker runtime/);
  });
});
