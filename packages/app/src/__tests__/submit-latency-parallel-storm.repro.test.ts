import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const RUN_SH = join(REPO_ROOT, 'run.sh');
const APP_DIST = join(REPO_ROOT, 'packages', 'app', 'dist');
const INTAKE_COUNT = 50;
const ACK_P95_BUDGET_MS = 200;
const CLIENT_TIMEOUT_MS = 40_000;
const TEST_TIMEOUT_MS = 180_000;

type IntakeResult = {
  name: string;
  ackMs: number;
  exitCode: number | null;
  workflowId: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type StoredWorkflow = {
  id?: unknown;
  name?: unknown;
};

type Fixture = {
  tempDir: string;
  dbDir: string;
  ipcSocket: string;
  env: NodeJS.ProcessEnv;
  names: string[];
  planPaths: string[];
};

let fixture: Fixture | undefined;

function runChecked(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error([
      `Command failed: ${command} ${args.join(' ')}`,
      `exitCode=${String(result.status)}`,
      `error=${result.error?.message ?? 'none'}`,
      `stdout=${result.stdout ?? ''}`,
      `stderr=${result.stderr ?? ''}`,
    ].join('\n'));
  }
  return result.stdout;
}

function ensureBuiltApp(): void {
  const mainPath = join(APP_DIST, 'main.js');
  const clientPath = join(APP_DIST, 'headless-client.js');
  if (existsSync(mainPath) && existsSync(clientPath)) return;
  runChecked('pnpm', ['--filter', '@invoker/app', 'build']);
}

function writePlan(path: string, name: string, repoUrl: string, taskId: string): void {
  writeFileSync(path, [
    `name: ${name}`,
    `repoUrl: ${repoUrl}`,
    'baseBranch: main',
    'onFinish: none',
    'mergeMode: no_op',
    'tasks:',
    `  - id: ${taskId}`,
    `    description: ${name}`,
    '    command: "true"',
    '    requiresManualApproval: true',
    '',
  ].join('\n'));
}

function createFixture(): Fixture {
  const tempDir = mkdtempSync(join(tmpdir(), 'invoker-parallel-storm-'));
  const homeDir = join(tempDir, 'home');
  const dbDir = join(tempDir, 'db');
  const ipcSocket = join(tempDir, 'ipc-transport.sock');
  const configPath = join(tempDir, 'config.json');
  const bareRepo = join(tempDir, 'remote.git');
  const seedRepo = join(tempDir, 'seed-repo');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(dbDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, maxConcurrency: 1 }));

  runChecked('git', ['init', '--bare', bareRepo]);
  runChecked('git', ['init', seedRepo]);
  runChecked('git', ['-C', seedRepo, 'config', 'user.email', 'repro@example.invalid']);
  runChecked('git', ['-C', seedRepo, 'config', 'user.name', 'Repro Runner']);
  writeFileSync(join(seedRepo, 'README.md'), 'parallel intake storm repro\n');
  runChecked('git', ['-C', seedRepo, 'add', 'README.md']);
  runChecked('git', ['-C', seedRepo, 'commit', '-m', 'seed repro repository']);
  runChecked('git', ['-C', seedRepo, 'branch', '-M', 'main']);
  runChecked('git', ['-C', seedRepo, 'remote', 'add', 'origin', bareRepo]);
  runChecked('git', ['-C', seedRepo, 'push', 'origin', 'main']);

  const repoUrl = pathToFileURL(bareRepo).href;
  const runToken = `${process.pid}-${Date.now()}`;
  const names = Array.from(
    { length: INTAKE_COUNT },
    (_, index) => `Parallel Storm ${runToken} ${String(index).padStart(2, '0')}`,
  );
  const planPaths = names.map((name, index) => {
    const planPath = join(tempDir, `storm-${index}.yaml`);
    writePlan(planPath, name, repoUrl, `storm-${index}`);
    return planPath;
  });
  const bootstrapPlan = join(tempDir, 'bootstrap.yaml');
  writePlan(bootstrapPlan, `Parallel Storm Bootstrap ${runToken}`, repoUrl, 'bootstrap');

  const env = {
    ...process.env,
    HOME: homeDir,
    INVOKER_DB_DIR: dbDir,
    INVOKER_IPC_SOCKET: ipcSocket,
    INVOKER_REPO_CONFIG_PATH: configPath,
    INVOKER_SKIP_BOOTSTRAP_CHECK: '1',
    INVOKER_HEADLESS_REQUIRE_EXISTING_OWNER: '1',
    INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS: '120000',
    INVOKER_API_PORT: '0',
    INVOKER_WEB_PORT: '0',
  };

  // Let this one command bootstrap the detached owner. The measured storm is
  // then forced through that already-running owner by REQUIRE_EXISTING_OWNER.
  const bootstrapEnv = { ...env };
  delete bootstrapEnv.INVOKER_HEADLESS_REQUIRE_EXISTING_OWNER;
  const bootstrapOutput = runChecked(
    RUN_SH,
    ['--headless', '--no-track', 'run', bootstrapPlan],
    bootstrapEnv,
  );
  if (!/workflow:\s*wf-/.test(bootstrapOutput)) {
    throw new Error(`Bootstrap did not print a workflow id: ${bootstrapOutput}`);
  }

  return { tempDir, dbDir, ipcSocket, env, names, planPaths };
}

function killProcessGroup(pid: number): void {
  try {
    if (process.platform === 'win32') process.kill(pid, 'SIGKILL');
    else process.kill(-pid, 'SIGKILL');
  } catch {
    // The process already settled.
  }
}

async function runIntake(name: string, planPath: string, env: NodeJS.ProcessEnv): Promise<IntakeResult> {
  const startedAt = performance.now();
  return await new Promise((resolveResult) => {
    const child = spawn(RUN_SH, ['--headless', '--no-track', 'run', planPath], {
      cwd: REPO_ROOT,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let externallyTimedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });

    const timer = setTimeout(() => {
      externallyTimedOut = true;
      killProcessGroup(child.pid!);
    }, CLIENT_TIMEOUT_MS);

    child.once('error', (error) => {
      stderr += `\nspawn error: ${error.message}`;
    });
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      const ackMs = performance.now() - startedAt;
      resolveResult({
        name,
        ackMs,
        exitCode,
        workflowId: stdout.match(/workflow:\s*(wf-[^\s]+)/)?.[1] ?? null,
        stdout,
        stderr,
        timedOut: externallyTimedOut || /timed out/i.test(stderr),
      });
    });
  });
}

function percentile95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function queryStoredWorkflows(current: Fixture): StoredWorkflow[] {
  const stdout = runChecked(
    RUN_SH,
    ['--headless', 'query', 'workflows', '--output', 'json'],
    current.env,
  );
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`Expected workflows JSON array, got: ${stdout}`);
  return parsed as StoredWorkflow[];
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return false;
}

async function stopOwner(current: Fixture): Promise<void> {
  const markerPath = join(current.dbDir, 'invoker.db.owner');
  if (!existsSync(markerPath)) return;
  const pidText = readFileSync(markerPath, 'utf8').trim();
  if (!/^[1-9]\d*$/.test(pidText)) throw new Error(`Invalid owner marker PID: ${pidText}`);
  const pid = Number(pidText);

  if (process.platform === 'linux') {
    const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
    const environ = readFileSync(`/proc/${pid}/environ`, 'utf8');
    const ownsFixture = environ.includes(`INVOKER_DB_DIR=${current.dbDir}\0`)
      || environ.includes(`INVOKER_IPC_SOCKET=${current.ipcSocket}\0`);
    if (!command.includes('packages/app/dist/main.js') || !command.includes('owner-serve') || !ownsFixture) {
      throw new Error(`Refusing to stop unverified owner pid=${pid} command=${command}`);
    }
  }

  process.kill(pid, 'SIGTERM');
  if (await waitForExit(pid, 5_000)) return;
  process.kill(pid, 'SIGKILL');
  if (!await waitForExit(pid, 2_000)) throw new Error(`Owner pid=${pid} did not exit`);
}

beforeAll(() => {
  ensureBuiltApp();
  fixture = createFixture();
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  if (!fixture) return;
  try {
    await stopOwner(fixture);
  } catch (error) {
    console.error(`[submit-latency-parallel-storm] owner cleanup error: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    rmSync(fixture.tempDir, { recursive: true, force: true });
  } catch (error) {
    console.error(`[submit-latency-parallel-storm] temp cleanup error: ${error instanceof Error ? error.message : String(error)}`);
  }
  fixture = undefined;
});

describe('parallel plan intake storm repro', () => {
  it('acknowledges and stores 50 simultaneous one-task plans within the explicit budget', async () => {
    const current = fixture!;
    const results = await Promise.all(
      current.names.map((name, index) => runIntake(name, current.planPaths[index]!, current.env)),
    );
    const workflows = queryStoredWorkflows(current);
    const counts = new Map(current.names.map((name) => [name, 0]));
    for (const workflow of workflows) {
      if (typeof workflow.name === 'string' && counts.has(workflow.name)) {
        counts.set(workflow.name, counts.get(workflow.name)! + 1);
      }
    }

    const p95 = percentile95(results.map((result) => result.ackMs));
    const lost = current.names.filter((name) => counts.get(name) === 0);
    const doubled = current.names.filter((name) => (counts.get(name) ?? 0) > 1);
    const nonZero = results.filter((result) => result.exitCode !== 0);
    const timedOut = results.filter((result) => result.timedOut);
    const hasDefect = p95 > ACK_P95_BUDGET_MS
      || lost.length > 0
      || doubled.length > 0
      || timedOut.length > 0;
    const details = [
      `p95=${p95.toFixed(1)}ms`,
      `budget=${ACK_P95_BUDGET_MS}ms`,
      `lost=${lost.join(',') || 'none'}`,
      `doubled=${doubled.join(',') || 'none'}`,
      `timedOut=${timedOut.map((result) => result.name).join(',') || 'none'}`,
      `nonZero=${nonZero.map((result) => `${result.name}(exit=${String(result.exitCode)},workflow=${result.workflowId ?? 'none'},stderr=${JSON.stringify(result.stderr)})`).join(';') || 'none'}`,
      `acks=${results.map((result) => `${result.name}:${result.ackMs.toFixed(1)}ms/exit=${String(result.exitCode)}/workflow=${result.workflowId ?? 'none'}`).join(';')}`,
    ].join(' ');
    console.error(`[submit-latency-parallel-storm] ${details}`);

    if (process.env.INVOKER_REPRO_EXPECT === 'bug') {
      expect(hasDefect, `expected at least one parallel intake defect: ${details}`).toBe(true);
      return;
    }

    expect(p95, details).toBeLessThan(ACK_P95_BUDGET_MS);
    expect(lost, details).toEqual([]);
    expect(doubled, details).toEqual([]);
    expect(nonZero, details).toEqual([]);
  }, TEST_TIMEOUT_MS);
});
