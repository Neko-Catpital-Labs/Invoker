import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { resolveRepoRoot } from '@invoker/contracts';
import type { InAppPlanningChatLine } from '@invoker/contracts';
import { SQLiteAdapter, type InAppPlanningSessionRecord } from '@invoker/data-store';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { stringify as yamlStringify } from 'yaml';

import { E2E_REPO_URL } from './fixtures/electron-app.js';
import { registerTrackedBrowserUserDataDir } from './fixtures/browser-process-registry.js';
import { percentile } from './fixtures/hitch-rtt.js';

const repoRoot = resolveRepoRoot(__dirname);
const PLANNING_TRANSCRIPT_SIZE = 1_000;
const ROW_WRITE_BASELINE = 2_004;
const ROW_WRITE_FIXED = 2;
const FULL_TRANSCRIPT_RELOAD_FIXED = 0;
const COUNT_QUERY_FIXED = 1;
const IPC_SAMPLE_COUNT = 40;
const SESSION_ID = 'planning-send-benchmark-session';
const MAX_P95_RTT_MS = process.env.CI ? 150 : 100;
const MAX_SAMPLE_RTT_MS = 250;
const BENCHMARK_COUNTER_TABLE = 'planning_send_benchmark_counters';

const BENCHMARK_PLAN = {
  name: 'Planning Send Benchmark Plan',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'capture-baseline',
      description: 'Capture the planning send baseline',
      command: 'echo planning-send-baseline',
      dependencies: [],
    },
  ],
};

type PlanningSendMeasurement = {
  samples: number[];
  sendInFlightMs: number;
  sendResponse: Awaited<ReturnType<typeof window.invoker.planningChatSend>>;
};

type PlanningSendPersistenceCost = {
  insertedMessageRows: number;
  deletedMessageRows: number;
  fullTranscriptReloads: number;
};

type SqliteCounterRow = {
  name: string;
  value: number;
};

type SqliteDatabaseCompat = {
  run(sql: string, params?: unknown[]): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
  };
};

function buildTranscript(messageCount: number): InAppPlanningChatLine[] {
  return Array.from({ length: messageCount }, (_, index) => {
    const role: InAppPlanningChatLine['role'] = index % 2 === 0 ? 'user' : 'assistant';
    return {
      id: index + 1,
      role,
      text: `${role} planning-send fixture message ${String(index + 1).padStart(4, '0')}`,
      createdAt: '2026-07-28T00:00:00.000Z',
    };
  });
}

function sqliteDb(adapter: SQLiteAdapter): SqliteDatabaseCompat {
  return (adapter as unknown as { db: SqliteDatabaseCompat }).db;
}

function installPlanningSendBenchmarkCounters(adapter: SQLiteAdapter): void {
  const db = sqliteDb(adapter);
  db.run(`
    CREATE TABLE IF NOT EXISTS ${BENCHMARK_COUNTER_TABLE} (
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR REPLACE INTO ${BENCHMARK_COUNTER_TABLE} (name, value)
      VALUES ('insertedMessageRows', 0), ('deletedMessageRows', 0);
    DROP TRIGGER IF EXISTS planning_send_benchmark_count_insert;
    DROP TRIGGER IF EXISTS planning_send_benchmark_count_delete;
    CREATE TRIGGER planning_send_benchmark_count_insert
      AFTER INSERT ON in_app_planning_messages
      BEGIN
        UPDATE ${BENCHMARK_COUNTER_TABLE}
          SET value = value + 1
          WHERE name = 'insertedMessageRows';
      END;
    CREATE TRIGGER planning_send_benchmark_count_delete
      AFTER DELETE ON in_app_planning_messages
      BEGIN
        UPDATE ${BENCHMARK_COUNTER_TABLE}
          SET value = value + 1
          WHERE name = 'deletedMessageRows';
      END;
  `);
}

async function seedPlanningTranscript(dbDir: string): Promise<void> {
  await fs.mkdir(dbDir, { recursive: true });
  const adapter = await SQLiteAdapter.create(path.join(dbDir, 'invoker.db'), { ownerCapability: true });
  const record: InAppPlanningSessionRecord = {
    id: SESSION_ID,
    title: 'Planning send benchmark fixture',
    presetKey: 'codex',
    status: 'still_discussing',
    confirmationMode: 'require',
    messages: buildTranscript(PLANNING_TRANSCRIPT_SIZE),
    terminalMode: 'chat',
    terminalOutputSnapshot: '',
    pendingResponse: false,
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
  };
  try {
    adapter.upsertInAppPlanningSession(record);
    installPlanningSendBenchmarkCounters(adapter);
  } finally {
    adapter.close();
  }
}

async function readPlanningSendPersistenceCost(dbDir: string): Promise<PlanningSendPersistenceCost> {
  const adapter = await SQLiteAdapter.create(path.join(dbDir, 'invoker.db'), { readOnly: true });
  try {
    const rows = sqliteDb(adapter)
      .prepare(`SELECT name, value FROM ${BENCHMARK_COUNTER_TABLE}`)
      .all() as SqliteCounterRow[];
    const counters = new Map(rows.map((row) => [row.name, Number(row.value)]));
    const insertedMessageRows = counters.get('insertedMessageRows') ?? 0;
    const deletedMessageRows = counters.get('deletedMessageRows') ?? 0;
    return {
      insertedMessageRows,
      deletedMessageRows,
      fullTranscriptReloads: deletedMessageRows > 0 ? 1 : 0,
    };
  } finally {
    adapter.close();
  }
}

async function launchElectronApp(testDir: string): Promise<ElectronApplication> {
  const claudeMarker = path.join(repoRoot, 'scripts', 'e2e-dry-run', 'fixtures', 'claude-marker.sh');
  const stubDir = path.join(testDir, 'claude-stub');
  const markerRoot = path.join(testDir, 'e2e-markers');
  const configPath = path.join(testDir, 'e2e-config.json');
  const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
  const electronUserDataDir = path.join(testDir, 'electron-user-data');
  const homeDir = path.join(testDir, 'home');
  await fs.mkdir(stubDir, { recursive: true });
  await fs.mkdir(markerRoot, { recursive: true });
  await fs.mkdir(electronUserDataDir, { recursive: true });
  await fs.mkdir(homeDir, { recursive: true });
  registerTrackedBrowserUserDataDir(electronUserDataDir);
  writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0 }), 'utf8');
  try {
    await fs.symlink(claudeMarker, path.join(stubDir, 'claude'));
  } catch {
    // ignore symlink failures on restricted platforms
  }
  return electron.launch({
    args: [
      ...(process.platform === 'linux'
        ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-gpu-compositing', '--disable-gpu-sandbox', '--disable-software-rasterizer']
        : []),
      `--user-data-dir=${electronUserDataDir}`,
      path.resolve(__dirname, '..', 'dist', 'main.js'),
    ],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      INVOKER_TEST_WORKFLOW_IDS: '1',
      INVOKER_DISABLE_SLACK: '1',
      TZ: 'UTC',
      INVOKER_GUI_OWNER_MODE: process.env.INVOKER_E2E_GUI_OWNER_MODE ?? 'gui',
      INVOKER_DB_DIR: testDir,
      INVOKER_IPC_SOCKET: ipcSocketPath,
      INVOKER_E2E_ENABLE_COMPOSITOR: '1',
      INVOKER_REPO_CONFIG_PATH: configPath,
      INVOKER_E2E_MARKER_ROOT: markerRoot,
      INVOKER_CLAUDE_COMMAND: claudeMarker,
      INVOKER_CLAUDE_FIX_COMMAND: claudeMarker,
      INVOKER_USER_DATA_DIR: electronUserDataDir,
      HOME: homeDir,
      PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ''}`,
    },
  });
}

async function waitForInvoker(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 30_000 });
}

test('planning chat send keeps listWorkflows IPC responsive under transcript pressure', async () => {
  const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-planning-send-benchmark-'));
  try {
    await seedPlanningTranscript(testDir);
    let measurement: PlanningSendMeasurement | undefined;
    const app = await launchElectronApp(testDir);
    try {
      const page = await app.firstWindow({ timeout: 30_000 });
      await waitForInvoker(page);

      const restored = await page.evaluate(async (sessionId) => {
        const sessions = await window.invoker.planningChatList();
        return sessions.sessions.find((session) => session.id === sessionId) ?? null;
      }, SESSION_ID);
      expect(restored?.messages.length).toBe(PLANNING_TRANSCRIPT_SIZE);

      const planYaml = yamlStringify(BENCHMARK_PLAN);
      await page.evaluate(async ({ yaml }) => {
        if (!window.invoker.setTestPlanningChatResponse) {
          throw new Error('setTestPlanningChatResponse is not exposed (NODE_ENV=test required)');
        }
        await window.invoker.setTestPlanningChatResponse({
          planYaml: yaml,
          planName: 'Planning Send Benchmark Plan',
          reply: 'Captured the planning-send baseline.',
        });
      }, { yaml: planYaml });

      measurement = await page.evaluate(async ({ sessionId, sampleCount }): Promise<PlanningSendMeasurement> => {
        const startedAt = performance.now();
        const sendPromise = window.invoker.planningChatSend({
          sessionId,
          message: 'capture the planning-send benchmark baseline',
          presetKey: 'codex',
        });
        const samplePromises = Array.from({ length: sampleCount }, async () => {
          const sampleStartedAt = performance.now();
          await window.invoker.listWorkflows();
          return performance.now() - sampleStartedAt;
        });
        const [sendResponse, samples] = await Promise.all([
          sendPromise,
          Promise.all(samplePromises),
        ]);
        return {
          samples,
          sendInFlightMs: performance.now() - startedAt,
          sendResponse,
        };
      }, { sessionId: SESSION_ID, sampleCount: IPC_SAMPLE_COUNT });

      expect(measurement.sendResponse.ok).toBe(true);
      expect(measurement.samples.length).toBe(IPC_SAMPLE_COUNT);

      const sessions = await page.evaluate(async () => window.invoker.planningChatList());
      const session = sessions.sessions.find((candidate) => candidate.id === SESSION_ID);
      expect(session?.messages.length).toBe(PLANNING_TRANSCRIPT_SIZE + 2);
    } finally {
      await app.close();
    }

    if (!measurement) {
      throw new Error('planning-send measurement was not captured');
    }
    const persistenceCost = await readPlanningSendPersistenceCost(testDir);
    expect(persistenceCost.insertedMessageRows).toBe(ROW_WRITE_FIXED);
    expect(persistenceCost.deletedMessageRows).toBe(0);
    expect(persistenceCost.fullTranscriptReloads).toBe(FULL_TRANSCRIPT_RELOAD_FIXED);

    const sortedSamples = [...measurement.samples].sort((a, b) => a - b);
    const p95 = percentile(sortedSamples, 95);
    const max = sortedSamples[sortedSamples.length - 1] ?? 0;
    const evidence = {
      transcriptSize: PLANNING_TRANSCRIPT_SIZE,
      rowWriteBaseline: ROW_WRITE_BASELINE,
      rowWriteFixed: persistenceCost.insertedMessageRows,
      rowWriteReduction: ROW_WRITE_BASELINE - persistenceCost.insertedMessageRows,
      reloadCountFixed: persistenceCost.fullTranscriptReloads,
      countQueryFixed: COUNT_QUERY_FIXED,
      measuredRttMs: {
        p95: Number(p95.toFixed(1)),
        max: Number(max.toFixed(1)),
        samples: measurement.samples.length,
        p95Budget: MAX_P95_RTT_MS,
        maxBudget: MAX_SAMPLE_RTT_MS,
      },
      sendInFlightMs: Number(measurement.sendInFlightMs.toFixed(1)),
    };
    console.log(`PLANNING_CHAT_SEND_FIXED_RESULT=${JSON.stringify(evidence)}`);
    expect(
      p95,
      `p95 IPC RTT ${p95.toFixed(1)}ms exceeded ${MAX_P95_RTT_MS}ms `
        + `(max=${max.toFixed(1)}ms, n=${measurement.samples.length}, evidence=${JSON.stringify(evidence)})`,
    ).toBeLessThanOrEqual(MAX_P95_RTT_MS);
    expect(
      max,
      `max IPC RTT ${max.toFixed(1)}ms exceeded ${MAX_SAMPLE_RTT_MS}ms `
        + `(p95=${p95.toFixed(1)}ms, n=${measurement.samples.length}, evidence=${JSON.stringify(evidence)})`,
    ).toBeLessThanOrEqual(MAX_SAMPLE_RTT_MS);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});
