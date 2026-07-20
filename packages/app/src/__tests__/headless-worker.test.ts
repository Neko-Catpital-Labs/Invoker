import { describe, expect, it, vi } from 'vitest';
import { PR_SUMMARY_REFRESH_WORKER_KIND } from '@invoker/execution-engine';
import { resolveHeadlessDiskHeadroomConfig, runHeadless } from '../headless.js';

describe('headless worker registry', () => {
  it('lists the PR summary refresh worker kind', async () => {
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
    expect(stdout).toContain(PR_SUMMARY_REFRESH_WORKER_KIND);
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
});
