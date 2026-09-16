import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HEADLESS_SET_SUBCOMMANDS } from '@invoker/contracts';
import { LocalBus } from '@invoker/transport';
import { ALREADY_TERMINAL_TASK_STATUSES } from '@invoker/workflow-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CLI_SET_FIELDS, main } from '../index.js';

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
    ['delete', 'wf-1'],
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

type OwnerTask = {
  id: string;
  status: string;
  config: Record<string, unknown>;
};

const TASK_ID = 'wf-1/task-a';

function ownerTask(overrides: Partial<OwnerTask> = {}): OwnerTask {
  return {
    id: TASK_ID,
    status: 'pending',
    config: { workflowId: 'wf-1', runnerKind: 'worktree', poolId: 'local-worktree' },
    ...overrides,
  };
}

function mergeNodeTask(): OwnerTask {
  return ownerTask({
    id: '__merge__wf-1',
    config: { workflowId: 'wf-1', runnerKind: 'merge', isMergeNode: true },
  });
}

function dockerTask(): OwnerTask {
  return ownerTask({ config: { workflowId: 'wf-1', runnerKind: 'docker' } });
}

function liveOwnerWithTask(task: OwnerTask) {
  const bus = new LocalBus();
  const queryHandler = vi.fn(async () => ({ output: JSON.stringify(task) }));
  const execHandler = vi.fn(async () => ({ ok: true }));
  bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
  bus.onRequest('headless.query', queryHandler);
  bus.onRequest('headless.exec', execHandler);
  return { bus, queryHandler, execHandler };
}

async function runSet(argv: string[], task: OwnerTask) {
  const output = captureProcessOutput();
  const owner = liveOwnerWithTask(task);
  const code = await main(['set', ...argv], { createMessageBus: () => owner.bus });
  output.restore();
  return { code, stdout: output.stdout, stderr: output.stderr, ...owner };
}

const POSITIVE_SET_CASES: Record<string, { task: OwnerTask; values: string[] }> = {
  command: { task: ownerTask(), values: ['pnpm', 'test'] },
  prompt: { task: ownerTask(), values: ['Fix the flaky assertion'] },
  pool: { task: ownerTask(), values: ['ssh', 'remote-1'] },
  executor: { task: ownerTask(), values: ['docker'] },
  agent: { task: ownerTask(), values: ['claude'] },
  model: { task: ownerTask(), values: ['claude-opus-5'] },
  'task-pool': { task: ownerTask(), values: ['gpu-pool'] },
  'fix-prompt': { task: ownerTask({ status: 'failed' }), values: ['Retry with verbose logging'] },
  'fix-context': { task: ownerTask({ status: 'failed' }), values: ['Build log excerpt'] },
  'gate-policy': { task: ownerTask(), values: ['wf-upstream', 'review_ready'] },
  task: { task: ownerTask(), values: ['config.poolId', 'gpu-pool'] },
};

describe('invoker-cli set', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts exactly the task-scoped set sub-commands in the headless registry', () => {
    const registryTaskFields = HEADLESS_SET_SUBCOMMANDS
      .filter((definition) => definition.scope === 'task')
      .map((definition) => definition.name);

    expect([...CLI_SET_FIELDS].sort()).toEqual([...registryTaskFields].sort());
  });

  it('has a positive case for every accepted field', () => {
    expect(Object.keys(POSITIVE_SET_CASES).sort()).toEqual([...CLI_SET_FIELDS].sort());
  });

  it('lists set as its own subcommand in --help with every accepted field', async () => {
    const output = captureProcessOutput();
    const code = await main(['--help']);
    output.restore();

    const usageBlock = output.stdout.split('\n\n')[0].split('\n').slice(1);
    const subcommands = usageBlock.map((line) => line.trim().split(/\s+/)[1]);
    expect(code).toBe(0);
    expect(subcommands).toContain('set');
    expect(output.stdout).toContain(`Fields: ${CLI_SET_FIELDS.join(', ')}.`);
  });

  it.each(Object.entries(POSITIVE_SET_CASES))('sends set %s to the live owner over headless.exec', async (field, { task, values }) => {
    const result = await runSet([field, TASK_ID, ...values], task);

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.queryHandler).toHaveBeenCalledWith({
      kind: 'cli-query',
      args: ['query', 'task', TASK_ID, '--output', 'json'],
    });
    expect(result.execHandler).toHaveBeenCalledTimes(1);
    expect(result.execHandler).toHaveBeenCalledWith({ args: ['set', field, TASK_ID, ...values], noTrack: true });
    expect(result.stdout).toContain(`set ${field} accepted by live owner.`);
  });

  it('allows an agent change on a merge node', async () => {
    const result = await runSet(['agent', '__merge__wf-1', 'codex'], mergeNodeTask());

    expect(result.code).toBe(0);
    expect(result.execHandler).toHaveBeenCalledWith({ args: ['set', 'agent', '__merge__wf-1', 'codex'], noTrack: true });
  });

  it('passes values after -- through verbatim', async () => {
    const result = await runSet(['command', TASK_ID, '--', 'git', 'push', '--force-with-lease'], ownerTask());

    expect(result.code).toBe(0);
    expect(result.execHandler).toHaveBeenCalledWith({
      args: ['set', 'command', TASK_ID, 'git', 'push', '--force-with-lease'],
      noTrack: true,
    });
  });

  it.each(['running', 'fixing_with_ai'])('edits a %s task when --force is given', async (status) => {
    const result = await runSet(['agent', TASK_ID, 'claude', '--force'], ownerTask({ status }));

    expect(result.code).toBe(0);
    expect(result.execHandler).toHaveBeenCalledWith({ args: ['set', 'agent', TASK_ID, 'claude'], noTrack: true });
  });

  it.each(ALREADY_TERMINAL_TASK_STATUSES)('refuses a %s task as terminal', async (status) => {
    const result = await runSet(['agent', TASK_ID, 'claude', '--force'], ownerTask({ status }));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`Cannot set agent on task "${TASK_ID}": it is ${status}, a terminal state.`);
    expect(result.execHandler).not.toHaveBeenCalled();
  });

  it.each(['running', 'fixing_with_ai'])('refuses a %s task without --force', async (status) => {
    const result = await runSet(['agent', TASK_ID, 'claude'], ownerTask({ status }));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`it is ${status} and its launched attempt has already resolved its configuration`);
    expect(result.stderr).toContain('re-run with --force');
    expect(result.execHandler).not.toHaveBeenCalled();
  });

  it.each([
    ['task-pool', ['gpu-pool']],
    ['pool', ['ssh', 'remote-1']],
    ['executor', ['worktree']],
    ['task', ['config.poolId', 'gpu-pool']],
  ])('refuses set %s on a merge node', async (field, values) => {
    const result = await runSet([field, '__merge__wf-1', ...values], mergeNodeTask());

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`Cannot set ${field} on task "__merge__wf-1": merge nodes run on the merge executor and cannot take a pool, pool member, or executor change.`);
    expect(result.execHandler).not.toHaveBeenCalled();
  });

  it('refuses to move a task onto the merge executor', async () => {
    const result = await runSet(['executor', TASK_ID, 'merge'], ownerTask());

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('the merge executor is reserved for merge nodes.');
    expect(result.execHandler).not.toHaveBeenCalled();
  });

  it.each(['docker', 'scratch'])('refuses a pool member for the %s executor', async (runnerKind) => {
    const result = await runSet(['pool', TASK_ID, runnerKind, 'remote-1'], ownerTask());

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${runnerKind} tasks cannot take a pool member.`);
    expect(result.execHandler).not.toHaveBeenCalled();
  });

  it('refuses a task-pool change on a docker task', async () => {
    const result = await runSet(['task-pool', TASK_ID, 'gpu-pool'], dockerTask());

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('docker tasks cannot take a pool.');
    expect(result.execHandler).not.toHaveBeenCalled();
  });

  it('refuses a config.poolId write on a docker task', async () => {
    const result = await runSet(['task', TASK_ID, 'config.poolId', 'gpu-pool'], dockerTask());

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('docker tasks cannot have a pool or pool member; use `invoker-cli set executor`');
    expect(result.execHandler).not.toHaveBeenCalled();
  });

  it('refuses a config.runnerKind write that would leave a docker task holding a pool', async () => {
    const result = await runSet(['task', TASK_ID, 'config.runnerKind', 'docker'], ownerTask());

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('docker tasks cannot have a pool or pool member');
    expect(result.execHandler).not.toHaveBeenCalled();
  });

  it('refuses clearing the pool of a worktree task', async () => {
    const result = await runSet(['task', TASK_ID, 'config.poolId', 'null'], ownerTask());

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('worktree tasks require a non-empty pool');
    expect(result.execHandler).not.toHaveBeenCalled();
  });

  it.each(
    HEADLESS_SET_SUBCOMMANDS.filter((definition) => definition.scope === 'workflow').map((definition) => definition.name),
  )('refuses the workflow-scoped %s sub-command without contacting the owner', async (field) => {
    const createMessageBus = vi.fn(() => new LocalBus());
    const output = captureProcessOutput();
    const code = await main(['set', field, 'wf-1', 'automatic'], { createMessageBus });
    output.restore();

    expect(code).toBe(1);
    expect(output.stderr).toContain(`Unknown set field: "${field}". Task fields: ${CLI_SET_FIELDS.join(', ')}`);
    expect(createMessageBus).not.toHaveBeenCalled();
  });

  it.each([
    [['agent'], 'Missing taskId.'],
    [['agent', TASK_ID], 'Missing value.'],
    [['agent', TASK_ID, '--froce', 'claude'], 'Unknown set option: --froce.'],
  ])('refuses incomplete or malformed set %j without contacting the owner', async (argv, message) => {
    const createMessageBus = vi.fn(() => new LocalBus());
    const output = captureProcessOutput();
    const code = await main(['set', ...argv], { createMessageBus });
    output.restore();

    expect(code).toBe(1);
    expect(output.stderr).toContain(message);
    expect(createMessageBus).not.toHaveBeenCalled();
  });

  it('refuses set when no owner is reachable', async () => {
    const output = captureProcessOutput();
    const code = await main(['set', 'agent', TASK_ID, 'claude'], { createMessageBus: () => new LocalBus() });
    output.restore();

    expect(code).toBe(1);
    expect(output.stderr).toContain('No running Invoker owner is reachable');
  });
});
