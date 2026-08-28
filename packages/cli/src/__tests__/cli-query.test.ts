import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteAdapter, type WorkflowSaveInput } from '@invoker/data-store';
import { LocalBus } from '@invoker/transport';
import type { TaskState, TaskStatus } from '@invoker/workflow-core';
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

function workflow(id: string, name: string, createdAt: string): WorkflowSaveInput {
  return {
    id,
    name,
    onFinish: 'none',
    createdAt,
    updatedAt: createdAt,
  };
}

function task(workflowId: string, id: string, status: TaskStatus, description: string): TaskState {
  return {
    id,
    description,
    status,
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId },
    execution: {},
    taskStateVersion: 1,
  };
}

async function seedDb(dbDir: string): Promise<void> {
  const persistence = await SQLiteAdapter.create(join(dbDir, 'invoker.db'), {
    ownerCapability: true,
    outputDir: join(dbDir, 'outputs'),
    slowQueryThresholdMs: 0,
  });
  try {
    persistence.saveWorkflow(workflow('wf-env', 'Env workflow', '2026-01-01T00:00:00.000Z'));
    persistence.saveTask('wf-env', task('wf-env', 'wf-env/task-complete', 'completed', 'Completed task'));
    persistence.saveTask('wf-env', task('wf-env', 'wf-env/task-failed', 'failed', 'Failed task'));

    persistence.saveWorkflow(workflow('wf-other', 'Other workflow', '2026-01-02T00:00:00.000Z'));
    persistence.saveTask('wf-other', task('wf-other', 'wf-other/task-running', 'running', 'Running task'));
  } finally {
    persistence.close();
  }
}

describe('invoker-cli query', () => {
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

  it('delegates query requests to a live owner with the cli-query request shape', async () => {
    const output = captureProcessOutput();
    const bus = new LocalBus();
    const queryHandler = vi.fn(async (request: unknown) => {
      expect(request).toEqual({
        kind: 'cli-query',
        args: ['query', 'tasks', '--workflow', 'wf-1', '--status', 'failed', '--output', 'json'],
      });
      return { output: '[]\n' };
    });
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
    bus.onRequest('headless.query', queryHandler);

    const code = await main(
      ['query', 'tasks', '--workflow', 'wf-1', '--status', 'failed', '--output', 'json'],
      { createMessageBus: () => bus },
    );

    expect(code).toBe(0);
    expect(queryHandler).toHaveBeenCalledTimes(1);
    expect(output.stdout).toBe('[]\n');
    output.restore();
  });

  it('uses INVOKER_DB_DIR for standalone read-only workflow queries', async () => {
    const dbDir = makeTempDir('invoker-cli-query-env-');
    await seedDb(dbDir);
    process.env.INVOKER_DB_DIR = dbDir;
    const output = captureProcessOutput();
    const createSpy = vi.spyOn(SQLiteAdapter, 'create');
    const bus = new LocalBus();

    const code = await main(['query', 'workflows', '--output', 'json'], { createMessageBus: () => bus });

    expect(code).toBe(0);
    const parsed = JSON.parse(output.stdout) as Array<{ id: string }>;
    expect(parsed.map((item) => item.id).sort()).toEqual(['wf-env', 'wf-other']);
    expect(createSpy).toHaveBeenCalledWith(
      join(dbDir, 'invoker.db'),
      expect.objectContaining({ readOnly: true }),
    );
    output.restore();
  });

  it('applies --status and --workflow filters for standalone task queries', async () => {
    const dbDir = makeTempDir('invoker-cli-query-filter-');
    await seedDb(dbDir);
    process.env.INVOKER_DB_DIR = dbDir;
    const output = captureProcessOutput();
    const bus = new LocalBus();

    const code = await main(
      ['query', 'tasks', '--workflow', 'wf-env', '--status', 'failed', '--output', 'json'],
      { createMessageBus: () => bus },
    );

    expect(code).toBe(0);
    expect(JSON.parse(output.stdout)).toEqual([
      expect.objectContaining({
        id: 'wf-env/task-failed',
        status: 'failed',
        config: expect.objectContaining({ workflowId: 'wf-env' }),
      }),
    ]);
    output.restore();
  });

  it('prints only parseable JSON on stdout for empty standalone databases', async () => {
    const dbDir = makeTempDir('invoker-cli-query-empty-');
    process.env.INVOKER_DB_DIR = dbDir;
    const output = captureProcessOutput();
    const bus = new LocalBus();

    const code = await main(['query', 'workflows', '--output', 'json'], { createMessageBus: () => bus });

    expect(code).toBe(0);
    expect(JSON.parse(output.stdout)).toEqual([]);
    expect(output.stdout).toBe('[]\n');
    output.restore();
  });
});
