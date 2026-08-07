import { describe, expect, it, vi } from 'vitest';
import { INFRA_REPAIR_WORKER_KIND } from '@invoker/execution-engine';
import {
  resolveHeadlessDiskHeadroomConfig,
  resolveHeadlessInfraRepairConfig,
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
});
