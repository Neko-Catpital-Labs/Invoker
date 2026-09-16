import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { IpcBus } from '@invoker/transport';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, spawnCalls } = vi.hoisted(() => ({
  spawnCalls: [] as unknown[][],
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

import { submitPlanForMcp } from '../mcp-server.js';

const intakeCount = 5;
const ackBudgetMs = 200;
const fakeProcessAckMs = 225;

const savedEnv = {
  HOME: process.env.HOME,
  INVOKER_DB_DIR: process.env.INVOKER_DB_DIR,
  INVOKER_IPC_SOCKET: process.env.INVOKER_IPC_SOCKET,
};

const tempDirs: string[] = [];
let ownerBus: IpcBus | undefined;
let ownerPingCount = 0;
let liveRunCount = 0;

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function restoreEnv(key: keyof typeof savedEnv): void {
  const value = savedEnv[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

function planPathFromSpawnArgs(args: unknown[]): string {
  const invocationArgs = args[1];
  if (!Array.isArray(invocationArgs)) {
    throw new Error(`Expected spawn args array, got ${typeof invocationArgs}`);
  }
  const runIndex = invocationArgs.indexOf('run');
  if (runIndex < 0 || typeof invocationArgs[runIndex + 1] !== 'string') {
    throw new Error(`Expected invoker-cli run <plan> args, got ${JSON.stringify(invocationArgs)}`);
  }
  return invocationArgs[runIndex + 1] as string;
}

function installSlowSuccessfulCliChild(): void {
  spawnMock.mockImplementation((...args: unknown[]) => {
    spawnCalls.push(args);
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter & { setEncoding: (encoding: BufferEncoding) => void };
      stderr: EventEmitter & { setEncoding: (encoding: BufferEncoding) => void };
    };
    child.stdout = new EventEmitter() as EventEmitter & { setEncoding: (encoding: BufferEncoding) => void };
    child.stderr = new EventEmitter() as EventEmitter & { setEncoding: (encoding: BufferEncoding) => void };
    child.stdout.setEncoding = () => undefined;
    child.stderr.setEncoding = () => undefined;
    void (async () => {
      const planPath = planPathFromSpawnArgs(args);
      await delay(fakeProcessAckMs);
      const socketPath = process.env.INVOKER_IPC_SOCKET;
      if (!socketPath) {
        throw new Error('INVOKER_IPC_SOCKET must point at the temp fake owner socket');
      }
      const clientBus = new IpcBus(socketPath, { allowServe: false });
      try {
        await clientBus.ready();
        await clientBus.request('headless.owner-ping', {});
        const submitted = await clientBus.request<{ planPath: string; traceId: string }, { workflowId: string; tasks: unknown[] }>(
          'headless.run',
          { planPath, traceId: `mcp-spawn-repro-${spawnCalls.length}` },
        );
        child.stdout.emit('data', `${JSON.stringify({ workflow: { id: submitted.workflowId } })}\n`);
        child.emit('close', 0, null);
      } catch (err) {
        child.stderr.emit('data', err instanceof Error ? err.message : String(err));
        child.emit('close', 1, null);
      } finally {
        clientBus.disconnect();
      }
    })();
    return child;
  });
}

function percentile50(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function formatMeasurements(samples: number[], spawnCount: number): string {
  const rounded = samples.map((sample) => Math.round(sample));
  return [
    `MCP submit latency repro measured p50=${Math.round(percentile50(samples))}ms`,
    `samples=[${rounded.join(', ')}]`,
    `spawnCount=${spawnCount}`,
    `ownerPingCount=${ownerPingCount}`,
    `liveRunCount=${liveRunCount}`,
    `intakes=${intakeCount}`,
    `budget=${ackBudgetMs}ms`,
    `expectation=${process.env.INVOKER_REPRO_EXPECT === 'bug' ? 'bug' : 'fixed'}`,
  ].join(' ');
}

describe('MCP path-mode plan intake spawn latency repro', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    spawnMock.mockReset();
    ownerPingCount = 0;
    liveRunCount = 0;
    installSlowSuccessfulCliChild();
  });

  afterEach(() => {
    ownerBus?.disconnect();
    ownerBus = undefined;
    vi.restoreAllMocks();
    restoreEnv('HOME');
    restoreEnv('INVOKER_DB_DIR');
    restoreEnv('INVOKER_IPC_SOCKET');
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps MCP path-mode submit inside the spawn and ack budget', async () => {
    const tempHome = makeTempDir('invoker-mcp-submit-home-');
    const tempDb = join(tempHome, 'db');
    const tempSocket = join(tempHome, 'owner.sock');
    const planPath = join(tempHome, 'plan.yaml');
    writeFileSync(planPath, [
      'name: MCP submit spawn latency repro',
      'onFinish: none',
      'mergeMode: no_op',
      'scratch: true',
      'tasks: []',
      '',
    ].join('\n'), 'utf8');

    process.env.HOME = tempHome;
    process.env.INVOKER_DB_DIR = tempDb;
    process.env.INVOKER_IPC_SOCKET = tempSocket;
    ownerBus = new IpcBus(tempSocket, { allowServe: true });
    await ownerBus.ready();
    ownerBus.onRequest('headless.owner-ping', async () => {
      ownerPingCount += 1;
      return { ok: true, ownerId: 'mcp-spawn-repro-owner', mode: 'test' };
    });
    ownerBus.onRequest('headless.run', async (req: unknown) => {
      liveRunCount += 1;
      expect(req).toEqual(expect.objectContaining({
        planPath,
        traceId: expect.stringMatching(/^mcp-spawn-repro-/),
      }));
      return { workflowId: `wf-mcp-spawn-${liveRunCount}`, tasks: [] };
    });

    const samples: number[] = [];
    for (let index = 0; index < intakeCount; index += 1) {
      const started = performance.now();
      const result = await submitPlanForMcp(planPath, 'live');
      samples.push(performance.now() - started);
      expect(result.ok).toBe(true);
    }

    const spawnCount = spawnCalls.length;
    const p50Ms = percentile50(samples);
    const measurement = formatMeasurements(samples, spawnCount);

    expect(process.env.HOME, measurement).toBe(tempHome);
    expect(process.env.INVOKER_DB_DIR, measurement).toBe(tempDb);
    expect(process.env.INVOKER_IPC_SOCKET, measurement).toBe(tempSocket);

    if (process.env.INVOKER_REPRO_EXPECT === 'bug') {
      expect(spawnCount, measurement).toBe(intakeCount);
      expect(spawnCalls.map((call) => (call as [string, string[]])[1])).toEqual(
        Array.from({ length: intakeCount }, () => [process.argv[1] ?? '', 'run', planPath, '--live', '--json']),
      );
      expect(p50Ms, measurement).toBeGreaterThan(ackBudgetMs);
      return;
    }

    expect(spawnCount, measurement).toBe(0);
    expect(p50Ms, measurement).toBeLessThan(ackBudgetMs);
  });
});
