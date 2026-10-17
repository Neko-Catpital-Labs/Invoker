import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteAdapter, type WorkflowSaveInput } from '@invoker/data-store';
import { readInvokerConfigFile, writeInvokerConfigFile } from '@invoker/contracts';
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

function task(
  workflowId: string,
  id: string,
  status: TaskStatus,
  description: string,
  config: Partial<TaskState['config']> = {},
): TaskState {
  return {
    id,
    description,
    status,
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId, ...config },
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
  const previousInvokerRepoConfigPath = process.env.INVOKER_REPO_CONFIG_PATH;

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
    if (previousInvokerRepoConfigPath === undefined) {
      delete process.env.INVOKER_REPO_CONFIG_PATH;
    } else {
      process.env.INVOKER_REPO_CONFIG_PATH = previousInvokerRepoConfigPath;
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

  it('forwards --filter to a live owner', async () => {
    const output = captureProcessOutput();
    const bus = new LocalBus();
    const filter = JSON.stringify({ op: 'eq', key: 'status', value: 'failed' });
    const queryHandler = vi.fn(async (request: unknown) => {
      expect(request).toEqual({ kind: 'cli-query', args: ['query', 'tasks', '--filter', filter] });
      return { output: '[]\n' };
    });
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
    bus.onRequest('headless.query', queryHandler);
    expect(await main(['query', 'tasks', '--filter', filter], { createMessageBus: () => bus })).toBe(0);
    expect(queryHandler).toHaveBeenCalledTimes(1);
    output.restore();
  });

  it('rejects a bare --filter', async () => {
    const output = captureProcessOutput();
    expect(await main(['query', 'tasks', '--filter'], { createMessageBus: () => new LocalBus() })).toBe(1);
    expect(output.stderr).toContain('Missing value for --filter');
    output.restore();
  });

  it('uses INVOKER_DB_DIR for standalone read-only workflow queries', async () => {
    const dbDir = makeTempDir('invoker-cli-query-env-');
    await seedDb(dbDir);
    process.env.INVOKER_DB_DIR = dbDir;
    const output = captureProcessOutput();
    const createSpy = vi.spyOn(SQLiteAdapter, 'create');
    const bus = new LocalBus();

    const code = await main(['query', 'workflows', '--output', 'json', '--standalone'], { createMessageBus: () => bus });

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
      ['query', 'tasks', '--workflow', 'wf-env', '--status', 'failed', '--output', 'json', '--standalone'],
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

  it('shows forceExecution pool and agent in standalone task query output without writing over the stored pin', async () => {
    const dbDir = makeTempDir('invoker-cli-query-force-');
    const configDir = makeTempDir('invoker-cli-query-force-config-');
    const configPath = join(configDir, 'config.json');
    process.env.INVOKER_DB_DIR = dbDir;
    process.env.INVOKER_REPO_CONFIG_PATH = configPath;
    writeInvokerConfigFile(configPath, {
      forceExecution: { poolId: 'local-worktree', executionAgent: 'claude' },
    });

    const persistence = await SQLiteAdapter.create(join(dbDir, 'invoker.db'), {
      ownerCapability: true,
      outputDir: join(dbDir, 'outputs'),
      slowQueryThresholdMs: 0,
    });
    try {
      persistence.saveWorkflow(workflow('wf-force', 'Force workflow', '2026-01-01T00:00:00.000Z'));
      persistence.saveTask('wf-force', task(
        'wf-force',
        'wf-force/task-forced',
        'pending',
        'Pinned elsewhere',
        { runnerKind: 'ssh', poolId: 'mixed-local-ssh', executionAgent: 'codex' },
      ));
    } finally {
      persistence.close();
    }

    const output = captureProcessOutput();
    const code = await main(
      ['query', 'tasks', '--workflow', 'wf-force', '--output', 'json', '--standalone'],
      { createMessageBus: () => new LocalBus() },
    );

    expect(code).toBe(0);
    expect(JSON.parse(output.stdout)).toEqual([
      expect.objectContaining({
        id: 'wf-force/task-forced',
        config: expect.objectContaining({
          runnerKind: 'ssh',
          poolId: 'local-worktree',
          executionAgent: 'claude',
        }),
      }),
    ]);
    output.restore();

    const readback = await SQLiteAdapter.create(join(dbDir, 'invoker.db'), {
      readOnly: true,
      outputDir: join(dbDir, 'outputs'),
      slowQueryThresholdMs: 0,
    });
    try {
      const stored = readback.loadWorkflowTaskSnapshot().tasks.find((item) => item.id === 'wf-force/task-forced');
      expect(stored?.config).toEqual(expect.objectContaining({
        runnerKind: 'ssh',
        poolId: 'mixed-local-ssh',
        executionAgent: 'codex',
      }));
    } finally {
      readback.close();
    }
  });

  it('reports stored pool and agent in standalone task query output when forceExecution is absent', async () => {
    const dbDir = makeTempDir('invoker-cli-query-no-force-');
    const configDir = makeTempDir('invoker-cli-query-no-force-config-');
    const configPath = join(configDir, 'config.json');
    process.env.INVOKER_DB_DIR = dbDir;
    process.env.INVOKER_REPO_CONFIG_PATH = configPath;
    writeInvokerConfigFile(configPath, {});

    const persistence = await SQLiteAdapter.create(join(dbDir, 'invoker.db'), {
      ownerCapability: true,
      outputDir: join(dbDir, 'outputs'),
      slowQueryThresholdMs: 0,
    });
    try {
      persistence.saveWorkflow(workflow('wf-force', 'Force workflow', '2026-01-01T00:00:00.000Z'));
      persistence.saveTask('wf-force', task(
        'wf-force',
        'wf-force/task-stored',
        'pending',
        'Pinned elsewhere',
        { runnerKind: 'ssh', poolId: 'mixed-local-ssh', executionAgent: 'codex' },
      ));
    } finally {
      persistence.close();
    }

    const output = captureProcessOutput();
    const code = await main(
      ['query', 'tasks', '--workflow', 'wf-force', '--output', 'json', '--standalone'],
      { createMessageBus: () => new LocalBus() },
    );

    expect(code).toBe(0);
    expect(JSON.parse(output.stdout)).toEqual([
      expect.objectContaining({
        id: 'wf-force/task-stored',
        config: expect.objectContaining({
          runnerKind: 'ssh',
          poolId: 'mixed-local-ssh',
          executionAgent: 'codex',
        }),
      }),
    ]);
    output.restore();
    expect(readInvokerConfigFile(configPath)).toEqual({});
  });

  it('does not report the forced pool for scratch, docker, and merge tasks while forcing the agent', async () => {
    const dbDir = makeTempDir('invoker-cli-query-force-exempt-');
    const configDir = makeTempDir('invoker-cli-query-force-exempt-config-');
    const configPath = join(configDir, 'config.json');
    process.env.INVOKER_DB_DIR = dbDir;
    process.env.INVOKER_REPO_CONFIG_PATH = configPath;
    writeInvokerConfigFile(configPath, {
      forceExecution: { poolId: 'local-worktree', executionAgent: 'claude' },
    });

    const persistence = await SQLiteAdapter.create(join(dbDir, 'invoker.db'), {
      ownerCapability: true,
      outputDir: join(dbDir, 'outputs'),
      slowQueryThresholdMs: 0,
    });
    try {
      persistence.saveWorkflow(workflow('wf-force-exempt', 'Force exempt workflow', '2026-01-01T00:00:00.000Z'));
      for (const runnerKind of ['scratch', 'docker', 'merge'] as const) {
        persistence.saveTask('wf-force-exempt', task(
          'wf-force-exempt',
          `wf-force-exempt/task-${runnerKind}`,
          'pending',
          `${runnerKind} task`,
          { runnerKind, poolId: `stored-${runnerKind}`, executionAgent: 'codex' },
        ));
      }
    } finally {
      persistence.close();
    }

    const output = captureProcessOutput();
    const code = await main(
      ['query', 'tasks', '--workflow', 'wf-force-exempt', '--output', 'json', '--standalone'],
      { createMessageBus: () => new LocalBus() },
    );

    expect(code).toBe(0);
    const rows = JSON.parse(output.stdout) as Array<{ id: string; config: Record<string, unknown> }>;
    expect(rows.map((row) => row.config)).toEqual(expect.arrayContaining([
      expect.objectContaining({ runnerKind: 'scratch', executionAgent: 'claude' }),
      expect.objectContaining({ runnerKind: 'docker', executionAgent: 'claude' }),
      expect.objectContaining({ runnerKind: 'merge', executionAgent: 'claude' }),
    ]));
    expect(rows.every((row) => row.config.poolId !== 'local-worktree')).toBe(true);
    output.restore();
  });

  it('prints only parseable JSON on stdout for empty standalone databases', async () => {
    const dbDir = makeTempDir('invoker-cli-query-empty-');
    process.env.INVOKER_DB_DIR = dbDir;
    const output = captureProcessOutput();
    const bus = new LocalBus();

    const code = await main(['query', 'workflows', '--output', 'json', '--standalone'], { createMessageBus: () => bus });

    expect(code).toBe(0);
    expect(JSON.parse(output.stdout)).toEqual([]);
    expect(output.stdout).toBe('[]\n');
    output.restore();
  });

  it('fails instead of printing standalone rows when no live owner is reachable', async () => {
    const dbDir = makeTempDir('invoker-cli-query-no-owner-');
    await seedDb(dbDir);
    process.env.INVOKER_DB_DIR = dbDir;
    const output = captureProcessOutput();
    const bus = new LocalBus();

    const code = await main(['query', 'tasks', '--output', 'json'], { createMessageBus: () => bus });

    expect(code).toBe(1);
    expect(output.stdout).toBe('');
    expect(output.stderr).toContain('No running Invoker owner is reachable');
    expect(output.stderr).toContain('--standalone');
    output.restore();
  });

  it('delegates a capacity query to a live owner with the cli-query request shape', async () => {
    const output = captureProcessOutput();
    const bus = new LocalBus();
    const queryHandler = vi.fn(async (request: unknown) => {
      expect(request).toEqual({
        kind: 'cli-query',
        args: ['query', 'capacity', '--output', 'json'],
      });
      return { output: '{"pools":[]}\n' };
    });
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
    bus.onRequest('headless.query', queryHandler);

    const code = await main(['query', 'capacity', '--output', 'json'], { createMessageBus: () => bus });

    expect(code).toBe(0);
    expect(queryHandler).toHaveBeenCalledTimes(1);
    expect(output.stdout).toBe('{"pools":[]}\n');
    output.restore();
  });

  it('refuses a standalone capacity query with a clear live-owner-required error', async () => {
    const dbDir = makeTempDir('invoker-cli-query-capacity-standalone-');
    await seedDb(dbDir);
    process.env.INVOKER_DB_DIR = dbDir;
    const output = captureProcessOutput();
    const bus = new LocalBus();

    const code = await main(['query', 'capacity', '--standalone'], { createMessageBus: () => bus });

    expect(code).toBe(1);
    expect(output.stderr).toContain('query capacity requires a live owner');
    output.restore();
  });

  it('forwards a single-task query id to a live owner as the first argument', async () => {
    const output = captureProcessOutput();
    const bus = new LocalBus();
    const queryHandler = vi.fn(async (request: unknown) => {
      expect(request).toEqual({
        kind: 'cli-query',
        args: ['query', 'task', 'wf-env/task-failed', '--output', 'json'],
      });
      return { output: '{"id":"wf-env/task-failed"}\n' };
    });
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
    bus.onRequest('headless.query', queryHandler);

    const code = await main(
      ['query', 'task', 'wf-env/task-failed', '--output', 'json'],
      { createMessageBus: () => bus },
    );

    expect(code).toBe(0);
    expect(queryHandler).toHaveBeenCalledTimes(1);
    expect(output.stdout).toBe('{"id":"wf-env/task-failed"}\n');
    output.restore();
  });

  it('forwards a single-workflow query id ahead of flags given before it', async () => {
    const output = captureProcessOutput();
    const bus = new LocalBus();
    const queryHandler = vi.fn(async (request: unknown) => {
      expect(request).toEqual({
        kind: 'cli-query',
        args: ['query', 'workflow', 'wf-env', '--output', 'json'],
      });
      return { output: '{"id":"wf-env"}\n' };
    });
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
    bus.onRequest('headless.query', queryHandler);

    const code = await main(
      ['query', 'workflow', '--output', 'json', 'wf-env'],
      { createMessageBus: () => bus },
    );

    expect(code).toBe(0);
    expect(queryHandler).toHaveBeenCalledTimes(1);
    expect(output.stdout).toBe('{"id":"wf-env"}\n');
    output.restore();
  });

  it('rejects a single-resource query with no id', async () => {
    const output = captureProcessOutput();

    expect(await main(['query', 'task'], { createMessageBus: () => new LocalBus() })).toBe(1);
    expect(output.stderr).toContain('Missing id. Usage: invoker-cli query task <id>');
    expect(await main(['query', 'workflow'], { createMessageBus: () => new LocalBus() })).toBe(1);
    expect(output.stderr).toContain('Missing id. Usage: invoker-cli query workflow <id>');
    output.restore();
  });

  it('rejects --workflow on a single-task query', async () => {
    const output = captureProcessOutput();

    const code = await main(
      ['query', 'task', 'wf-env/task-failed', '--workflow', 'wf-env'],
      { createMessageBus: () => new LocalBus() },
    );

    expect(code).toBe(1);
    expect(output.stderr).toContain('--workflow is only supported for `query tasks`');
    output.restore();
  });

  it('still rejects a positional argument on a list query', async () => {
    const output = captureProcessOutput();

    const code = await main(['query', 'tasks', 'wf-env'], { createMessageBus: () => new LocalBus() });

    expect(code).toBe(1);
    expect(output.stderr).toContain('Unexpected query argument: wf-env');
    output.restore();
  });

  it('rejects a second positional argument on a single-task query', async () => {
    const output = captureProcessOutput();

    const code = await main(
      ['query', 'task', 'wf-env/task-failed', 'wf-env/task-complete'],
      { createMessageBus: () => new LocalBus() },
    );

    expect(code).toBe(1);
    expect(output.stderr).toContain('Unexpected query argument: wf-env/task-complete');
    output.restore();
  });
});
