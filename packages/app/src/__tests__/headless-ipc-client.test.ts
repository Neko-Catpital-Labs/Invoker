import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { IpcBus, type MessageBus } from '@invoker/transport';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  parseThinIpcArgs,
  readOwnerRunAck,
  runHeadlessIpcClient,
} from '../headless-ipc-client.js';

type OwnerRunHandler = (request: { planPath: string; traceId?: string }) => unknown;

type Harness = {
  dir: string;
  socketPath: string;
  planPath: string;
  owner?: IpcBus;
  stdout: string[];
  stderr: string[];
};

let harness: Harness;

function createHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'thin-ipc-client-'));
  const planPath = join(dir, 'plan.yaml');
  writeFileSync(planPath, 'name: Thin Client Plan\ntasks: []\n', 'utf8');
  return { dir, socketPath: join(dir, 'ipc.sock'), planPath, stdout: [], stderr: [] };
}

async function startOwner(handler: OwnerRunHandler): Promise<IpcBus> {
  const owner = new IpcBus(harness.socketPath, { allowServe: true });
  await owner.ready();
  expect(owner.isServing()).toBe(true);
  owner.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'thin-ipc-owner', mode: 'standalone' }));
  owner.onRequest('headless.run', async (req: unknown) => handler(req as { planPath: string; traceId?: string }));
  harness.owner = owner;
  return owner;
}

async function runClient(argv: string[], overrides: { messageBus?: MessageBus } = {}): Promise<number> {
  return runHeadlessIpcClient(argv, {
    socketPath: harness.socketPath,
    connectTimeoutMs: 2_000,
    runTimeoutMs: 2_000,
    stdout: (line) => { harness.stdout.push(line); },
    stderr: (line) => { harness.stderr.push(line); },
    ...overrides,
  });
}

function stdoutText(): string {
  return harness.stdout.join('');
}

function stderrText(): string {
  return harness.stderr.join('');
}

beforeEach(() => {
  harness = createHarness();
});

afterEach(() => {
  harness.owner?.disconnect();
  rmSync(harness.dir, { recursive: true, force: true });
});

describe('parseThinIpcArgs', () => {
  it('accepts the run.sh style argv and resolves the flags', () => {
    expect(parseThinIpcArgs(['--headless', '--no-track', 'run', '/tmp/plan.yaml'])).toEqual({
      kind: 'run',
      args: { planPath: '/tmp/plan.yaml', waitForApproval: false, noTrack: true },
    });
    expect(parseThinIpcArgs(['run', 'plan.yaml', '--wait-for-approval'])).toEqual({
      kind: 'run',
      args: { planPath: 'plan.yaml', waitForApproval: true, noTrack: false },
    });
  });

  it('rejects a missing plan, a foreign command, and an unknown flag', () => {
    expect(parseThinIpcArgs(['run'])).toMatchObject({ kind: 'invalid' });
    expect(parseThinIpcArgs(['query', 'workflows'])).toMatchObject({ kind: 'invalid' });
    expect(parseThinIpcArgs(['run', 'plan.yaml', '--watch'])).toMatchObject({ kind: 'invalid' });
    expect(parseThinIpcArgs([])).toMatchObject({ kind: 'invalid' });
  });
});

describe('readOwnerRunAck', () => {
  it('accepts an ack that carries a workflow id and keeps every reported id', () => {
    expect(readOwnerRunAck({
      workflowId: 'wf-2',
      workflowIds: ['wf-1', 'wf-2'],
      planName: 'Thin Client Plan',
      tasks: [],
    })).toEqual({
      kind: 'submitted',
      workflowId: 'wf-2',
      workflowIds: ['wf-1', 'wf-2'],
      planName: 'Thin Client Plan',
    });
  });

  it('rejects an ack-only response, a blank id, and a non-object response', () => {
    expect(readOwnerRunAck({ ok: true })).toMatchObject({ kind: 'rejected' });
    expect(readOwnerRunAck({ workflowId: '   ' })).toMatchObject({ kind: 'rejected' });
    expect(readOwnerRunAck({ workflowId: 7 })).toMatchObject({ kind: 'rejected' });
    expect(readOwnerRunAck(null)).toMatchObject({ kind: 'rejected' });
    expect(readOwnerRunAck('wf-1')).toMatchObject({ kind: 'rejected' });
  });
});

describe('runHeadlessIpcClient', () => {
  it('exits 0 and prints the owner workflow id, sending the plan path absolute', async () => {
    const received: Array<{ planPath: string; traceId?: string }> = [];
    await startOwner((req) => {
      received.push(req);
      return { workflowId: 'wf-thin-1', workflowIds: ['wf-thin-1'], workflowCount: 1, planName: 'Thin Client Plan', tasks: [] };
    });

    const code = await runClient(['--headless', '--no-track', 'run', harness.planPath]);

    expect(code, stderrText()).toBe(0);
    expect(stdoutText()).toBe('Workflow ID: wf-thin-1\n');
    expect(received).toHaveLength(1);
    expect(received[0]?.planPath).toBe(resolve(harness.planPath));
    expect(received[0]?.traceId).toMatch(/^headless\.run:thin:/);
  });

  it('resolves a relative plan path before requesting the owner intake', async () => {
    const originalCwd = process.cwd();
    const received: Array<{ planPath: string; traceId?: string }> = [];
    await startOwner((req) => {
      received.push(req);
      return { workflowId: 'wf-owner-relative', workflowIds: ['wf-owner-relative'], tasks: [] };
    });

    try {
      process.chdir(harness.dir);

      const code = await runClient(['--headless', '--no-track', 'run', 'plan.yaml']);

      expect(code, stderrText()).toBe(0);
      expect(stdoutText()).toBe('Workflow ID: wf-owner-relative\n');
      expect(received).toHaveLength(1);
      expect(received[0]?.planPath).toBe(resolve(harness.dir, 'plan.yaml'));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('exits non-zero when the owner acks without a persisted workflow id', async () => {
    await startOwner(() => ({ ok: true }));

    const code = await runClient(['run', harness.planPath]);

    expect(code).toBe(1);
    expect(stdoutText()).toBe('');
    expect(stderrText()).toContain('without a persisted workflow id');
    expect(stderrText()).toContain(harness.planPath);
  });

  it('reports the resolved plan path when a relative-path run is rejected', async () => {
    const originalCwd = process.cwd();
    await startOwner(() => ({ ok: true }));

    try {
      process.chdir(harness.dir);

      const code = await runClient(['run', 'plan.yaml']);

      expect(code).toBe(1);
      expect(stdoutText()).toBe('');
      expect(stderrText()).toContain('without a persisted workflow id');
      expect(stderrText()).toContain(resolve(harness.dir, 'plan.yaml'));
      expect(stderrText()).not.toContain('plan "plan.yaml"');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('exits non-zero when the owner reports an empty workflow id', async () => {
    await startOwner(() => ({ workflowId: '', tasks: [] }));

    expect(await runClient(['run', harness.planPath])).toBe(1);
    expect(stdoutText()).toBe('');
  });

  it('exits non-zero and surfaces the reason when the owner intake throws', async () => {
    await startOwner(() => { throw new Error('plan "Thin Client Plan" did not create a workflow.'); });

    const code = await runClient(['run', harness.planPath]);

    expect(code).toBe(1);
    expect(stdoutText()).toBe('');
    expect(stderrText()).toContain('did not create a workflow');
  });

  it('exits non-zero without creating any file when no owner is listening', async () => {
    const code = await runClient(['run', harness.planPath]);

    expect(code).toBe(1);
    expect(stdoutText()).toBe('');
    expect(stderrText()).toContain('no reachable owner');
    expect(readFileSync(harness.planPath, 'utf8')).toBe('name: Thin Client Plan\ntasks: []\n');
  });

  it('exits non-zero when the owner never answers headless.run', async () => {
    await startOwner(async () => new Promise(() => {}));

    const code = await runClient(['run', harness.planPath]);

    expect(code).toBe(1);
    expect(stdoutText()).toBe('');
    expect(stderrText()).toMatch(/did not ack headless\.run within \d+ms/);
  });

  it('never reaches the owner, and exits non-zero, for a command it does not implement', async () => {
    const seen: string[] = [];
    await startOwner(() => {
      seen.push('run');
      return { workflowId: 'wf-should-not-happen', tasks: [] };
    });

    expect(await runClient(['query', 'workflows'])).toBe(1);
    expect(seen).toEqual([]);
    expect(stdoutText()).toBe('');
  });
});
