import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';

import { afterEach, describe, expect, it } from 'vitest';

import type { Logger } from '@invoker/contracts';
import { SQLiteAdapter } from '@invoker/data-store';
import { LocalBus } from '@invoker/transport';
import { Orchestrator } from '@invoker/workflow-core';

import { createGuiMutationTaskActions, type HeadlessRunMutationPayload } from '../ipc/gui-mutation-handlers.js';
import type { InvokerConfig } from '../config.js';

const ACK_BUDGET_MS = 200;
const SAMPLE_COUNT = 5;
const CONTROLLED_REPRO_RUN = process.env.INVOKER_REPRO_EXPECT === 'bug' || process.env.INVOKER_REPRO_EXPECT === 'fixed';
const ORIGINAL_ENV = {
  HOME: process.env.HOME,
  INVOKER_DB_DIR: process.env.INVOKER_DB_DIR,
  INVOKER_REPO_CONFIG_PATH: process.env.INVOKER_REPO_CONFIG_PATH,
  PATH: process.env.PATH,
};
const ORIGINAL_PATH = process.env.PATH ?? '';
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], {
  encoding: 'utf8',
  env: { ...process.env, PATH: ORIGINAL_PATH },
}).trim();

type LatencySample = {
  intakeMs: number;
  ownerReadMs: number;
};

const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return logger;
  },
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function writeSlowGitShim(binDir: string): void {
  const fakeGitPath = join(binDir, 'git');
  writeFileSync(
    fakeGitPath,
    `#!/bin/sh
if [ "$1" = "ls-remote" ]; then
  sleep 0.8
  exit 0
fi
exec ${shellQuote(REAL_GIT)} "$@"
`,
  );
  chmodSync(fakeGitPath, 0o755);
}

function writePlan(planPath: string): void {
  writeFileSync(
    planPath,
    `name: Remote Probe Ack Repro
repoUrl: https://example.invalid/fake/repo.git
onFinish: none
mergeMode: no_op
tasks:
  - id: shell-task
    description: One shell task
    command: "printf 'done\\\\n'"
`,
  );
}

function percentile50(samples: number[]): number {
  return [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
}

function max(samples: number[]): number {
  return Math.max(...samples);
}

function formatMs(ms: number): string {
  return ms.toFixed(1);
}

function summarize(samples: LatencySample[]): string {
  const intake = samples.map((sample) => sample.intakeMs);
  const ownerRead = samples.map((sample) => sample.ownerReadMs);
  return [
    `budget=${ACK_BUDGET_MS}ms`,
    `intakeAck p50=${formatMs(percentile50(intake))}ms max=${formatMs(max(intake))}ms samples=[${intake.map(formatMs).join(', ')}]`,
    `concurrentOwnerRead p50=${formatMs(percentile50(ownerRead))}ms max=${formatMs(max(ownerRead))}ms samples=[${ownerRead.map(formatMs).join(', ')}]`,
  ].join('; ');
}

function requestOwnerReadFromWorker(ownerBus: LocalBus): { promise: Promise<number>; worker: Worker } {
  const worker = new Worker(
    `
const { parentPort } = require('node:worker_threads');

setTimeout(() => {
  parentPort.postMessage({ kind: 'owner-read', issuedAtMs: Date.now() });
}, 100);
`,
    { eval: true },
  );
  const promise = new Promise<number>((resolve, reject) => {
    worker.once('error', reject);
    worker.once('message', (message: unknown) => {
      const request = message as { kind?: string; issuedAtMs?: number };
      if (request.kind !== 'owner-read' || typeof request.issuedAtMs !== 'number') {
        reject(new Error(`Unexpected worker message: ${JSON.stringify(message)}`));
        return;
      }
      ownerBus.request<{ kind: string }, ReturnType<Orchestrator['getQueueStatus']>>('headless.query', { kind: 'queue' })
        .then(() => resolve(Date.now() - request.issuedAtMs), reject);
    });
  });
  return { promise, worker };
}

async function measureSample(): Promise<LatencySample> {
  const rootDir = mkdtempSync(join(tmpdir(), 'submit-latency-remote-probe-'));
  const homeDir = join(rootDir, 'home');
  const dbDir = join(rootDir, 'db');
  const binDir = join(rootDir, 'bin');
  const planPath = join(rootDir, 'plan.yaml');
  let adapter: SQLiteAdapter | undefined;
  let ownerReadWorker: Worker | undefined;

  try {
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(dbDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeSlowGitShim(binDir);
    writePlan(planPath);

    process.env.HOME = homeDir;
    process.env.INVOKER_DB_DIR = dbDir;
    process.env.INVOKER_REPO_CONFIG_PATH = join(homeDir, '.invoker', 'config.json');
    process.env.PATH = `${binDir}${delimiter}${ORIGINAL_PATH}`;

    adapter = await SQLiteAdapter.create(join(dbDir, 'invoker.db'), { ownerCapability: true });
    const ownerBus = new LocalBus();
    const orchestrator = new Orchestrator({
      persistence: adapter as never,
      messageBus: ownerBus,
      maxConcurrency: 0,
    });
    const invokerConfig: InvokerConfig = {
      allowGraphMutation: true,
      executionPools: {},
    };
    const actions = createGuiMutationTaskActions({
      logger,
      persistence: adapter,
      messageBus: ownerBus,
      executorRegistry: {} as never,
      agentRegistry: {} as never,
      repoRoot: rootDir,
      invokerConfig,
      effectiveMaxConcurrency: 0,
      taskHandles: new Map(),
      getOrchestrator: () => orchestrator,
      setOrchestrator: () => {},
      getCommandService: () => ({} as never),
      setCommandService: () => {},
      getWorkflowMutationCoordinator: () => null,
      workflowMutationDispatcher: new Map(),
      getActiveMutationContext: () => undefined,
      getRendererTaskFeed: () => ({ publishSnapshot: () => {} }) as never,
      getStartupWorkflowId: () => null,
      getLaunchDispatcher: () => null,
      requireTaskExecutor: () => ({} as never),
      getTaskExecutor: () => null,
      rebuildTaskRunner: () => {},
      initServices: async () => {},
      requestWorkflowMetadataPublish: () => {},
      cancelDeferredWorkflowLaunch: () => {},
      killRunningTask: async () => {},
      buildCommandServiceInvalidationDeps: () => ({} as never),
    });

    ownerBus.onRequest<HeadlessRunMutationPayload, Awaited<ReturnType<typeof actions.executeHeadlessRun>>>(
      'headless.run',
      (payload) => actions.executeHeadlessRun(payload),
    );
    ownerBus.onRequest<{ kind: string }, ReturnType<Orchestrator['getQueueStatus']>>(
      'headless.query',
      async (request) => {
        if (request.kind !== 'queue') {
          throw new Error(`Unexpected owner read kind: ${request.kind}`);
        }
        return orchestrator.getQueueStatus({ refresh: false });
      },
    );

    const ownerRead = requestOwnerReadFromWorker(ownerBus);
    ownerReadWorker = ownerRead.worker;
    const intakeStartedAt = performance.now();
    const intake = ownerBus.request<HeadlessRunMutationPayload, Awaited<ReturnType<typeof actions.executeHeadlessRun>>>(
      'headless.run',
      { planPath },
    );

    const result = await intake;
    const intakeMs = performance.now() - intakeStartedAt;
    expect(result.workflowId).toMatch(/^wf-/);

    return {
      intakeMs,
      ownerReadMs: await ownerRead.promise,
    };
  } finally {
    await ownerReadWorker?.terminate();
    adapter?.close();
    restoreEnv();
    rmSync(rootDir, { recursive: true, force: true });
  }
}

describe.skipIf(!CONTROLLED_REPRO_RUN)('remote repoUrl probe intake latency repro', () => {
  afterEach(() => {
    restoreEnv();
  });

  it('keeps plan intake ack and concurrent owner reads inside the 200ms budget', async () => {
    const samples: LatencySample[] = [];
    for (let i = 0; i < SAMPLE_COUNT; i += 1) {
      samples.push(await measureSample());
    }

    const summary = summarize(samples);
    console.info(`[remote-probe-latency] ${summary}`);
    const intakeP50 = percentile50(samples.map((sample) => sample.intakeMs));
    const ownerReadP50 = percentile50(samples.map((sample) => sample.ownerReadMs));

    if (process.env.INVOKER_REPRO_EXPECT === 'bug') {
      expect(
        intakeP50,
        `expected current bug to breach intake ack budget; ${summary}`,
      ).toBeGreaterThan(ACK_BUDGET_MS);
      return;
    }

    expect(
      intakeP50,
      `intake ack exceeded budget; ${summary}`,
    ).toBeLessThan(ACK_BUDGET_MS);
    expect(
      ownerReadP50,
      `concurrent owner read exceeded budget; ${summary}`,
    ).toBeLessThan(ACK_BUDGET_MS);
  }, 20_000);
});
