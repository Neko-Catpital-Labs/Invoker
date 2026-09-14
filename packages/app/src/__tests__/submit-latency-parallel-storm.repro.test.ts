import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';
import { IpcBus } from '@invoker/transport';

import { discoverOwner, isStandaloneCapable } from '../owner-endpoint.js';

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
  id?: string;
  name?: string;
};

type ReproEnv = NodeJS.ProcessEnv & {
  INVOKER_IPC_SOCKET: string;
};

const repoRoot = resolve(__dirname, '../../../..');
const appMain = resolve(repoRoot, 'packages/app/dist/main.js');
const headlessClient = resolve(repoRoot, 'packages/app/dist/headless-client.js');
const electronLauncher = resolve(repoRoot, 'scripts/electron.cjs');
const intakeCount = 50;
const ackBudgetMs = 200;
const intakeTimeoutMs = 20_000;

function ensureBuiltApp(): void {
  if (existsSync(appMain) && existsSync(headlessClient)) return;
  const build = spawnSync('pnpm', ['--filter', '@invoker/app', 'build'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (build.status !== 0) {
    throw new Error(
      `Failed to build @invoker/app before repro\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
    );
  }
}

function runChecked(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `Command failed: ${command} ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

function seedBareRepo(tempDir: string): string {
  const bareRepo = join(tempDir, 'remote.git');
  const seedRepo = join(tempDir, 'seed-repo');
  runChecked('git', ['init', '--bare', bareRepo], tempDir);
  runChecked('git', ['init', seedRepo], tempDir);
  runChecked('git', ['config', 'user.email', 'repro@example.invalid'], seedRepo);
  runChecked('git', ['config', 'user.name', 'Parallel Storm Repro'], seedRepo);
  writeFileSync(join(seedRepo, 'README.md'), 'parallel storm repro\n');
  runChecked('git', ['add', 'README.md'], seedRepo);
  runChecked('git', ['commit', '-m', 'seed repro repository'], seedRepo);
  runChecked('git', ['branch', '-M', 'main'], seedRepo);
  runChecked('git', ['remote', 'add', 'origin', bareRepo], seedRepo);
  runChecked('git', ['push', 'origin', 'main'], seedRepo);
  return bareRepo;
}

function makeEnv(tempDir: string): ReproEnv {
  const homeDir = join(tempDir, 'home');
  const dbDir = join(homeDir, '.invoker');
  const userDataDir = join(tempDir, 'electron-user-data');
  const socketPath = join(tempDir, 'ipc-transport.sock');
  const configPath = join(tempDir, 'config.json');
  const envPath = join(tempDir, '.env');
  const logPath = join(tempDir, 'invoker.log');
  mkdirSync(dbDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, maxConcurrency: 1 }));
  writeFileSync(envPath, '');

  return {
    ...process.env,
    HOME: homeDir,
    INVOKER_DB_DIR: dbDir,
    INVOKER_USER_DATA_DIR: userDataDir,
    INVOKER_IPC_SOCKET: socketPath,
    INVOKER_REPO_CONFIG_PATH: configPath,
    INVOKER_ENV_PATH: envPath,
    INVOKER_LOG_PATH: logPath,
    INVOKER_API_PORT: '0',
    INVOKER_WEB_PORT: '0',
    INVOKER_DEVELOPMENT_PROFILE: '1',
    INVOKER_DEVELOPMENT_PROFILE_ACTIVE: '1',
    INVOKER_RUNTIME_KIND: 'source-development',
    INVOKER_SOURCE_ROOT: repoRoot,
    INVOKER_PROFILE_ID: `parallel-storm-${process.pid}`,
    INVOKER_HEADLESS_STANDALONE: '1',
    INVOKER_HEADLESS_REQUIRE_EXISTING_OWNER: '1',
    INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS: '600000',
    INVOKER_UNSAFE_DISABLE_DB_WRITER_LOCK: '1',
    INVOKER_SKIP_BOOTSTRAP_CHECK: '1',
    INVOKER_E2E_HIDE_WINDOW: '1',
    INVOKER_DISABLE_AUTONOMOUS_WORKERS: '1',
    INVOKER_DISABLE_AUTO_RUN_ON_STARTUP: '1',
    INVOKER_STARTUP_POLL_DELAY_MS: '0',
    LIBGL_ALWAYS_SOFTWARE: process.platform === 'linux' ? '1' : process.env.LIBGL_ALWAYS_SOFTWARE,
  };
}

async function waitForOwner(env: ReproEnv, ownerLog: () => string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 90_000) {
    const bus = new IpcBus(env.INVOKER_IPC_SOCKET, { allowServe: false });
    try {
      await bus.ready();
      const owner = await discoverOwner(bus, 2_000);
      if (isStandaloneCapable(owner)) return;
    } catch {
      // Keep polling until the owner process has registered its handlers.
    } finally {
      bus.disconnect();
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 250));
  }
  throw new Error(`Timed out waiting for isolated owner-serve\nowner log:\n${ownerLog()}`);
}

function startOwner(env: ReproEnv): { child: ChildProcess; log: () => string } {
  const args = [electronLauncher, appMain, '--headless', 'owner-serve'];
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { log += chunk; });
  child.stderr?.on('data', (chunk: string) => { log += chunk; });
  child.on('exit', (code, signal) => {
    log += `\n[owner exited code=${code} signal=${signal}]\n`;
  });
  return { child, log: () => log };
}

async function stopOwner(owner: ChildProcess | undefined): Promise<void> {
  if (!owner || owner.exitCode !== null || owner.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => {
    owner.once('exit', () => resolveExit());
  });
  owner.kill('SIGTERM');
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 2_000)),
  ]);
  if (!stopped && owner.exitCode === null && owner.signalCode === null) {
    owner.kill('SIGKILL');
    await Promise.race([
      exited,
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
    ]);
  }
}

async function removeTempDir(tempDir: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(tempDir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    }
  }
  throw lastError;
}

function writePlan(planDir: string, name: string, repoUrl: string): string {
  const planPath = join(planDir, `${name}.yaml`);
  writeFileSync(planPath, [
    `name: ${name}`,
    `repoUrl: ${repoUrl}`,
    'onFinish: none',
    'baseBranch: main',
    'tasks:',
    '  - id: root',
    `    description: ${name} approval gate`,
    '    command: echo root',
    '    requiresManualApproval: true',
    '',
  ].join('\n'));
  return planPath;
}

function runIntake(env: ReproEnv, planPath: string, name: string): Promise<IntakeResult> {
  return new Promise((resolveRun) => {
    const started = Date.now();
    const child = spawn(process.execPath, [headlessClient, 'run', planPath, '--no-track'], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, intakeTimeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.on('exit', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const workflowId = stdout.match(/workflow:\s*(wf-[^\s]+)/)?.[1] ?? null;
      resolveRun({
        name,
        ackMs: Date.now() - started,
        exitCode,
        workflowId,
        stdout,
        stderr,
        timedOut,
      });
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveRun({
        name,
        ackMs: Date.now() - started,
        exitCode: null,
        workflowId: null,
        stdout,
        stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}`,
        timedOut,
      });
    });
  });
}

async function queryStoredWorkflows(env: ReproEnv): Promise<StoredWorkflow[]> {
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun) => {
    const child = spawn(process.execPath, [headlessClient, 'query', 'workflows', '--output', 'json'], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.on('exit', (code) => resolveRun({ code, stdout, stderr }));
    child.on('error', (error) => resolveRun({
      code: null,
      stdout,
      stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}`,
    }));
  });
  if (result.code !== 0) {
    throw new Error(
      `Failed to query workflows from throwaway owner, exit=${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout) as StoredWorkflow[];
}

function percentile95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function summarize(
  results: IntakeResult[],
  storedByName: Map<string, number>,
): {
  p95: number;
  lost: string[];
  doubled: string[];
  timedOut: string[];
  nonZero: string[];
  detail: string;
} {
  const p95 = percentile95(results.map((result) => result.ackMs));
  const lost = results.map((result) => result.name).filter((name) => (storedByName.get(name) ?? 0) === 0);
  const doubled = results.map((result) => result.name).filter((name) => (storedByName.get(name) ?? 0) > 1);
  const timedOut = results.filter((result) => result.timedOut).map((result) => result.name);
  const nonZero = results
    .filter((result) => result.exitCode !== 0)
    .map((result) => {
      const firstStderrLine = result.stderr.trim().split('\n').find((line) => line.trim()) ?? '<empty stderr>';
      return `${result.name}: exit=${result.exitCode} timedOut=${result.timedOut} ackMs=${result.ackMs} stderr=${firstStderrLine}`;
    });
  const resultDetails = results.map((result) => (
    `${result.name}:${result.ackMs}ms:exit=${result.exitCode}:wf=${result.workflowId ?? 'none'}`
  ));
  const detail = [
    `ack p95=${p95}ms budget=${ackBudgetMs}ms`,
    `lost=${lost.length ? lost.join(', ') : 'none'}`,
    `doubled=${doubled.length ? doubled.join(', ') : 'none'}`,
    `timedOut=${timedOut.length ? timedOut.join(', ') : 'none'}`,
    `nonZero=${nonZero.length ? nonZero.join('; ') : 'none'}`,
    `results=${resultDetails.join(', ')}`,
  ].join('\n');
  return { p95, lost, doubled, timedOut, nonZero, detail };
}

describe('parallel plan intake storm repro', () => {
  const tempDirs: string[] = [];
  let owner: ChildProcess | undefined;

  afterAll(async () => {
    try {
      await stopOwner(owner);
    } catch (error) {
      console.error(`parallel storm repro cleanup: failed to stop owner: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const tempDir of tempDirs.splice(0)) {
      try {
        await removeTempDir(tempDir);
      } catch (error) {
        console.error(`parallel storm repro cleanup: failed to remove ${tempDir}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });

  it('keeps 50 parallel no-track plan intakes within the explicit ack and persistence budget', async () => {
    ensureBuiltApp();
    const tempDir = mkdtempSync(join(tmpdir(), 'invoker-parallel-storm-'));
    tempDirs.push(tempDir);
    const env = makeEnv(tempDir);
    const repoUrl = pathToFileURL(seedBareRepo(tempDir)).href;
    const planDir = join(tempDir, 'plans');
    mkdirSync(planDir);
    const ownerProcess = startOwner(env);
    owner = ownerProcess.child;
    await waitForOwner(env, ownerProcess.log);

    const planNames = Array.from({ length: intakeCount }, (_, index) => (
      `parallel-storm-${String(index + 1).padStart(2, '0')}`
    ));
    const plans = planNames.map((name) => writePlan(planDir, name, repoUrl));
    const results = await Promise.all(
      plans.map((planPath, index) => runIntake(env, planPath, planNames[index])),
    );
    const workflows = await queryStoredWorkflows(env);
    const storedByName = new Map<string, number>();
    for (const workflow of workflows) {
      if (!workflow.name?.startsWith('parallel-storm-')) continue;
      storedByName.set(workflow.name, (storedByName.get(workflow.name) ?? 0) + 1);
    }

    const summary = summarize(results, storedByName);
    const observedBug = summary.p95 > ackBudgetMs
      || summary.lost.length > 0
      || summary.doubled.length > 0
      || summary.timedOut.length > 0;

    if (process.env.INVOKER_REPRO_EXPECT === 'bug') {
      expect(observedBug, summary.detail).toBe(true);
      return;
    }

    expect(summary.p95, summary.detail).toBeLessThanOrEqual(ackBudgetMs);
    expect(summary.lost, summary.detail).toEqual([]);
    expect(summary.doubled, summary.detail).toEqual([]);
    expect(summary.timedOut, summary.detail).toEqual([]);
    expect(summary.nonZero, summary.detail).toEqual([]);
  }, 240_000);
});
