import { LocalBus } from '@invoker/transport';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../index.js';
import { captureProcessOutput, fixturePlan, runCli } from './cli-test-helpers.js';

describe('invoker-cli core', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('--help exits 0', () => {
    const result = runCli(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('invoker-cli run <plan.yaml>');
    expect(result.stdout).toContain('invoker-cli worker autofix [--count <n>]');
  });

  it('lists worker service commands', async () => {
    const output = captureProcessOutput();
    try {
      const code = await main(['worker', 'list']);
      expect(code).toBe(0);
      expect(output.stdout).toContain('autofix');
      expect(output.stdout).toContain('Long-running auto-fix recovery worker');
    } finally {
      output.restore();
    }
  });

  it('routes worker autofix through the explicit worker bridge', async () => {
    const output = captureProcessOutput();
    const runWorkerAutofix = vi.fn(async () => 0);
    try {
      const code = await main(['worker', 'autofix', '--count', '2', '--interval-ms', '1000'], { runWorkerAutofix });
      expect(code).toBe(0);
      expect(runWorkerAutofix).toHaveBeenCalledWith(['--count', '2', '--interval-ms', '1000'], expect.objectContaining({
        mode: 'auto',
      }));
      expect(output.stderr).toBe('');
    } finally {
      output.restore();
    }
  });

  it('--live delegates run to a reachable GUI owner', async () => {
    const output = captureProcessOutput();
    const bus = new LocalBus();
    const runHandler = vi.fn(async (req: unknown) => {
      expect(req).toEqual(expect.objectContaining({
        planPath: fixturePlan,
        traceId: expect.stringContaining('invoker-cli.headless.run'),
      }));
      return { workflowId: 'wf-live-1', tasks: [] };
    });
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'gui-1', mode: 'gui' }));
    bus.onRequest('headless.run', runHandler);

    const code = await main(['run', fixturePlan, '--live'], { createMessageBus: () => bus });

    expect(code).toBe(0);
    expect(runHandler).toHaveBeenCalledTimes(1);
    expect(output.stdout).toContain('Delegated to live owner - workflow: wf-live-1');
    output.restore();
  });

  it('--live exits non-zero when no GUI owner is reachable', async () => {
    const output = captureProcessOutput();
    const bus = new LocalBus();

    const code = await main(['run', fixturePlan, '--live'], { createMessageBus: () => bus });

    expect(code).toBe(1);
    expect(output.stderr).toContain('No running Invoker UI owner is reachable');
    output.restore();
  });

  it('rejects --db-dir with --live', async () => {
    const output = captureProcessOutput();
    const code = await main(['run', fixturePlan, '--live', '--db-dir', '/tmp/invoker-cli-live-db']);
    expect(code).toBe(1);
    expect(output.stderr).toContain('--db-dir cannot be used with --live');
    output.restore();
  });
});
