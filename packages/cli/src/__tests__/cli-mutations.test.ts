import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalBus } from '@invoker/transport';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../index.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function captureProcessOutput() {
  let stdout = '';
  let stderr = '';
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    stdout += chunk.toString();
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
    stderr += chunk.toString();
    return true;
  });
  return {
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    restore() {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    },
  };
}

describe('invoker-cli mutations', () => {
  const previousInvokerDbDir = process.env.INVOKER_DB_DIR;

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    if (previousInvokerDbDir === undefined) {
      delete process.env.INVOKER_DB_DIR;
    } else {
      process.env.INVOKER_DB_DIR = previousInvokerDbDir;
    }
  });

  it('runs delete-all against the default production DB root with no guard', async () => {
    process.env.INVOKER_DB_DIR = join(process.env.HOME ?? '', '.invoker');
    const output = captureProcessOutput();
    const bus = new LocalBus();
    const execHandler = vi.fn(async (request: unknown) => {
      expect(request).toEqual({ args: ['delete-all'], noTrack: true });
      return { ok: true };
    });
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
    bus.onRequest('headless.exec', execHandler);

    const code = await main(['delete-all'], { createMessageBus: () => bus });

    expect(code).toBe(0);
    expect(execHandler).toHaveBeenCalledTimes(1);
    expect(output.stdout).toContain('delete-all accepted by live owner.');
    output.restore();
  });

  it.each([
    ['retry-task', 'wf-1/task-1'],
    ['retry', 'wf-1'],
    ['resume', 'wf-1'],
  ])('sends %s over headless.exec with noTrack', async (command, targetId) => {
    const output = captureProcessOutput();
    const bus = new LocalBus();
    const execHandler = vi.fn(async (request: unknown) => {
      expect(request).toEqual({ args: [command, targetId], noTrack: true });
      return { ok: true };
    });
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
    bus.onRequest('headless.exec', execHandler);

    const code = await main([command, targetId], { createMessageBus: () => bus });

    expect(code).toBe(0);
    expect(execHandler).toHaveBeenCalledTimes(1);
    output.restore();
  });

  it('refuses owner-required mutations with actionable guidance when no owner is reachable', async () => {
    const output = captureProcessOutput();
    const bus = new LocalBus();

    const code = await main(['retry-task', 'wf-1/task-1'], { createMessageBus: () => bus });

    expect(code).toBe(1);
    expect(output.stderr).toContain('No running Invoker owner is reachable');
    expect(output.stderr).toContain('start the Invoker app or run `invoker-cli owner serve`');
    output.restore();
  });

  it('prints retry-tasks dry-run task IDs without issuing mutation requests', async () => {
    const output = captureProcessOutput();
    const bus = new LocalBus();
    const execHandler = vi.fn(async () => ({ ok: true }));
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
    bus.onRequest('headless.query', async (request: unknown) => {
      expect(request).toEqual({
        kind: 'cli-query',
        args: ['query', 'tasks', '--status', 'failed', '--output', 'json'],
      });
      return {
        output: JSON.stringify([
          { id: 'wf-1/task-a', status: 'failed' },
          { id: 'wf-1/task-b', status: 'completed' },
          { id: 'wf-2/task-c', status: 'failed' },
        ]),
      };
    });
    bus.onRequest('headless.exec', execHandler);

    const code = await main(['retry-tasks', '--status', 'failed', '--dry-run'], { createMessageBus: () => bus });

    expect(code).toBe(0);
    expect(output.stdout).toContain('wf-1/task-a');
    expect(output.stdout).toContain('wf-2/task-c');
    expect(output.stdout).not.toContain('wf-1/task-b');
    expect(execHandler).not.toHaveBeenCalled();
    output.restore();
  });

  it('issues retry-tasks mutations with bounded concurrency and reports accepted and failed counts', async () => {
    const output = captureProcessOutput();
    const bus = new LocalBus();
    const running: string[] = [];
    let maxRunning = 0;
    const release = Promise.withResolvers<void>();
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
    bus.onRequest('headless.query', async () => ({
      output: JSON.stringify([
        { id: 'wf-1/task-a', status: 'failed' },
        { id: 'wf-1/task-b', status: 'failed' },
        { id: 'wf-1/task-c', status: 'failed' },
      ]),
    }));
    bus.onRequest('headless.exec', async (request: unknown) => {
      const args = (request as { args?: unknown[] }).args;
      const taskId = String(args?.[1]);
      running.push(taskId);
      maxRunning = Math.max(maxRunning, running.length);
      await release.promise;
      running.splice(running.indexOf(taskId), 1);
      if (taskId === 'wf-1/task-b') {
        throw new Error('rejected');
      }
      return { ok: true };
    });

    const run = main(['retry-tasks', '--status', 'failed', '--parallel', '2'], { createMessageBus: () => bus });
    await vi.waitFor(() => {
      expect(maxRunning).toBe(2);
    });
    release.resolve();
    const code = await run;

    expect(code).toBe(1);
    expect(maxRunning).toBeLessThanOrEqual(2);
    expect(output.stdout).toContain('Accepted 2 task(s); failed 1 task(s).');
    expect(output.stderr).toContain('Failed to retry wf-1/task-b: rejected');
    output.restore();
  });

  it('dry-runs retry-tasks from an empty standalone DB directory without an owner', async () => {
    const output = captureProcessOutput();
    const dbDir = makeTempDir('invoker-cli-mutations-empty-');
    process.env.INVOKER_DB_DIR = dbDir;
    const bus = new LocalBus();

    const code = await main(['retry-tasks', '--status', 'failed', '--dry-run'], { createMessageBus: () => bus });

    expect(code).toBe(0);
    expect(output.stdout).toContain('No tasks matched status "failed".');
    output.restore();
  });
});
