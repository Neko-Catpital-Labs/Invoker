import { describe, expect, it, vi } from 'vitest';
import { E2E_AUTOFIX_WORKER_KIND, INFRA_REPAIR_WORKER_KIND } from '@invoker/execution-engine';
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

describe('headless worker start/stop', () => {
  // Incident 2026-08-13: `--headless worker stop <kind>` is documented (see
  // docs/remote-ssh-targets.md) and has a full delegation implementation in
  // headless-client.ts, but nothing in the actual runtime dispatch
  // (runHeadless -> headlessWorker) calls it -- "start"/"stop" fall through
  // to the single-kind manual-tick branch, which rejects them as unknown
  // worker kinds. `invoker-ui --headless worker stop e2e-autofix` fails with
  // `Unknown worker kind: "stop"` against a live owner, even though a live
  // WorkerRuntimeController (now reachable via getWorkerRuntimeController)
  // is available and able to do it. The next slice makes these pass.
  it('currently rejects "stop" as an unknown worker kind, even with a live controller available', async () => {
    const stop = vi.fn();
    await expect(runHeadless(['worker', 'stop', E2E_AUTOFIX_WORKER_KIND], {
      invokerConfig: {},
      getWorkerRuntimeController: () => ({ start: vi.fn(), stop } as never),
    } as never)).rejects.toThrow(/Unknown worker kind: "stop"/);
    expect(stop).not.toHaveBeenCalled();
  });

  it('currently rejects "start" as an unknown worker kind, even with a live controller available', async () => {
    const start = vi.fn();
    await expect(runHeadless(['worker', 'start', E2E_AUTOFIX_WORKER_KIND], {
      invokerConfig: {},
      getWorkerRuntimeController: () => ({ start, stop: vi.fn() } as never),
    } as never)).rejects.toThrow(/Unknown worker kind: "start"/);
    expect(start).not.toHaveBeenCalled();
  });
});
