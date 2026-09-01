import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test as base, expect, type Page } from '@playwright/test';
import { resolveRepoRoot, type Logger } from '@invoker/contracts';
import { SQLiteAdapter } from '@invoker/data-store';
import { registerBuiltinAgents } from '@invoker/execution-engine';
import { LocalBus } from '@invoker/transport';
import { Orchestrator } from '@invoker/workflow-core';
import type { ApiMutationFacade } from '../../src/api-server.js';
import type { InvokerConfig } from '../../src/config.js';
import { OwnerCapabilityRegistry } from '../../src/owner-capability-registry.js';
import {
  startHeadlessWebSurface,
  type StartHeadlessWebSurfaceDeps,
} from '../../src/web/start-web-surface.js';

export const WEB_SURFACE_WORKFLOW_ID = 'wf-web-surface-parity';
export const WEB_SURFACE_TASK_ID = `${WEB_SURFACE_WORKFLOW_ID}/task-fail`;
export const WEB_SURFACE_SCREENSHOT_NAME = 'web-surface-codex-only-parity';

type RepairCall = {
  taskId: string;
  agentName: string;
};

type LifecycleCall = {
  channel: string;
  request: unknown;
};

export interface WebSurfaceFixture {
  baseUrl: string;
  token: string;
  homeDir: string;
  repairCalls: RepairCall[];
  lifecycleCalls: LifecycleCall[];
  captureScreenshot(page: Page): Promise<string | null>;
  close(): Promise<void>;
}

const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return logger;
  },
};

function withIsolatedWebListener<T>(fn: () => T): T {
  const keys = ['INVOKER_WEB_TOKEN', 'INVOKER_WEB_HOST', 'INVOKER_WEB_PORT'] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.INVOKER_WEB_TOKEN = 'web-surface-e2e-token';
  process.env.INVOKER_WEB_HOST = '127.0.0.1';
  process.env.INVOKER_WEB_PORT = '0';
  try {
    return fn();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export async function startWebSurfaceFixture(): Promise<WebSurfaceFixture> {
  const repoRoot = resolveRepoRoot(__dirname);
  const homeDir = await mkdtemp(path.join(tmpdir(), 'invoker-web-surface-home-'));
  const token = 'web-surface-e2e-token';
  const config: InvokerConfig = {
    webToken: token,
    webHost: '127.0.0.1',
    webPort: 0,
    enabledExecutionAgents: ['codex'],
    defaultExecutionAgent: 'codex',
    autoFixRetries: 0,
  };
  await writeFile(path.join(homeDir, 'config.json'), JSON.stringify(config), 'utf8');

  const persistence = await SQLiteAdapter.create(path.join(homeDir, 'invoker.db'), {
    ownerCapability: true,
  });
  const messageBus = new LocalBus();
  const orchestrator = new Orchestrator({
    persistence,
    messageBus,
    maxConcurrency: 1,
  });
  const createdAt = '2026-08-31T12:00:00.000Z';
  persistence.saveWorkflow({
    id: WEB_SURFACE_WORKFLOW_ID,
    name: 'Web surface capability parity',
    description: 'Deterministic failed workflow for browser parity proof',
    repoUrl: 'file:///tmp/invoker-web-surface-parity.git',
    onFinish: 'none',
    createdAt,
    updatedAt: createdAt,
  });
  persistence.saveTask(WEB_SURFACE_WORKFLOW_ID, {
    id: WEB_SURFACE_TASK_ID,
    description: 'Repair this deterministic failure',
    status: 'failed',
    dependencies: [],
    createdAt: new Date(createdAt),
    taskStateVersion: 1,
    config: {
      workflowId: WEB_SURFACE_WORKFLOW_ID,
      command: 'exit 1',
      executionAgent: 'codex',
    },
    execution: {
      completedAt: new Date(createdAt),
      exitCode: 1,
      error: 'deterministic web-surface failure',
    },
  });
  orchestrator.syncAllFromDb();

  const ownerCapabilities = new OwnerCapabilityRegistry();
  const repairCalls: RepairCall[] = [];
  const lifecycleCalls: LifecycleCall[] = [];
  ownerCapabilities.register('invoker:fix-with-agent', async (taskIdArg, agentNameArg) => {
    const taskId = String(taskIdArg);
    const agentName = String(agentNameArg);
    repairCalls.push({ taskId, agentName });
    const { savedError } = orchestrator.beginFixSession(taskId);
    orchestrator.setFixAwaitingApproval(taskId, savedError);
    return {
      ok: true,
      accepted: true,
      intentId: 101,
      workflowId: WEB_SURFACE_WORKFLOW_ID,
      channel: 'invoker:fix-with-agent',
    };
  });
  ownerCapabilities.register('invoker:start-ready', async (request) => {
    lifecycleCalls.push({ channel: 'invoker:start-ready', request });
    return {
      ok: true,
      source: 'shared-owner-registry',
      dryRun: true,
    };
  });

  let bridge: ReturnType<typeof startHeadlessWebSurface> = null;
  let closed = false;
  const disposeTemporaryState = async (): Promise<void> => {
    try {
      messageBus.disconnect();
    } finally {
      try {
        persistence.close();
      } finally {
        await rm(homeDir, { recursive: true, force: true });
      }
    }
  };
  try {
    const deps: StartHeadlessWebSurfaceDeps = {
      logger,
      orchestrator,
      persistence,
      messageBus,
      agentRegistry: registerBuiltinAgents(),
      mutations: {} as ApiMutationFacade,
      deleteWorkflow: async () => {},
      detachWorkflow: async () => {},
      loadConfig: () => config,
      config,
      appRootDir: path.join(repoRoot, 'packages', 'app', 'dist'),
      ownerCapabilities,
    };
    bridge = withIsolatedWebListener(() => startHeadlessWebSurface(deps));
    if (!bridge) throw new Error('Web surface did not start with a configured token');
    const port = await bridge.whenReady;
    const baseUrl = `http://127.0.0.1:${port}`;

    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      try {
        await bridge?.close();
      } finally {
        await disposeTemporaryState();
      }
    };

    return {
      baseUrl,
      token,
      homeDir,
      repairCalls,
      lifecycleCalls,
      async captureScreenshot(page: Page): Promise<string | null> {
        const mode = process.env.CAPTURE_MODE;
        if (!mode) return null;
        const directory = path.join(repoRoot, 'packages', 'app', 'e2e', 'visual-proof', mode);
        const screenshotPath = path.join(directory, `${WEB_SURFACE_SCREENSHOT_NAME}.png`);
        await mkdir(directory, { recursive: true });
        await page.setViewportSize({ width: 1200, height: 771 });
        await page.screenshot({ path: screenshotPath, timeout: 60_000 });
        return screenshotPath;
      },
      close,
    };
  } catch (error) {
    try {
      await bridge?.close();
    } finally {
      await disposeTemporaryState();
    }
    throw error;
  }
}

export const test = base.extend<{ webSurface: WebSurfaceFixture }>({
  webSurface: async ({}, use) => {
    const webSurface = await startWebSurfaceFixture();
    try {
      await use(webSurface);
    } finally {
      await webSurface.close();
    }
  },
});

export { expect };
