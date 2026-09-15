import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
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
import { pathToFileURL } from 'node:url';

import { IpcBus } from '@invoker/transport';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../../..');
const RUN_SH = join(REPO_ROOT, 'run.sh');
const ELECTRON_LAUNCHER = join(REPO_ROOT, 'scripts/electron.cjs');
const APP_MAIN = join(REPO_ROOT, 'packages/app/dist/main.js');
const HEADLESS_CLIENT = join(REPO_ROOT, 'packages/app/dist/headless-client.js');

const STORM_SIZE = 50;
const ACK_BUDGET_MS = 200;
const OWNER_READY_TIMEOUT_MS = 90_000;
const CLIENT_HARNESS_TIMEOUT_MS = 30_000;

type OwnerFixture = {
  rootDir: string;
  homeDir: string;
  dbDir: string;
  socketPath: string;
  configPath: string;
  repoUrl: string;
  owner: ChildProcess;
  ownerLog: () => string;
};

type IntakeResult = {
  planName: string;
  planPath: string;
  ackMs: number;
  exitCode: number | null;
  workflowId: string | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
};

type WorkflowRow = {
  id?: string;
  name?: string;
};

function ensureAppBuilt(): void {
  if (existsSync(APP_MAIN) && existsSync(HEADLESS_CLIENT)) return;
  execFileSync('pnpm', ['--filter', '@invoker/app', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
}

function seedBareRepo(rootDir: string): string {
  const remoteRepo = join(rootDir, 'r.git');
  const seedRepo = join(rootDir, 'seed');
  execFileSync('git', ['init', '--bare', remoteRepo], { stdio: 'ignore' });
  execFileSync('git', ['init', seedRepo], { stdio: 'ignore' });
  execFileSync('git', ['-C', seedRepo, 'config', 'user.email', 'repro@example.invalid']);
  execFileSync('git', ['-C', seedRepo, 'config', 'user.name', 'Repro Runner']);
  writeFileSync(join(seedRepo, 'README.md'), 'parallel storm repro\n');
  execFileSync('git', ['-C', seedRepo, 'add', 'README.md']);
  execFileSync('git', ['-C', seedRepo, 'commit', '-m', 'seed repro repository'], { stdio: 'ignore' });
  execFileSync('git', ['-C', seedRepo, 'branch', '-M', 'main']);
  execFileSync('git', ['-C', seedRepo, 'remote', 'add', 'origin', remoteRepo]);
  execFileSync('git', ['-C', seedRepo, 'push', 'origin', 'main'], { stdio: 'ignore' });
  return pathToFileURL(remoteRepo).href;
}

function ownerEnv(fixture: Pick<OwnerFixture, 'homeDir' | 'dbDir' | 'socketPath' | 'configPath'>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: fixture.homeDir,
    INVOKER_DB_DIR: fixture.dbDir,
    INVOKER_IPC_SOCKET: fixture.socketPath,
    INVOKER_REPO_CONFIG_PATH: fixture.configPath,
    INVOKER_SKIP_BOOTSTRAP_CHECK: '1',
    INVOKER_E2E_HIDE_WINDOW: '1',
    INVOKER_HEADLESS_STANDALONE: '1',
    INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS: '600000',
    INVOKER_STARTUP_POLL_DELAY_MS: '0',
  };
}

function startOwner(): OwnerFixture {
  ensureAppBuilt();
  const rootDir = mkdtempSync(join(tmpdir(), 'inv-ps-'));
  const homeDir = join(rootDir, 'h');
  const dbDir = join(rootDir, 'd');
  const socketPath = join(rootDir, 's.sock');
  const configPath = join(rootDir, 'c.json');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(dbDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, maxConcurrency: 1 }));
  const repoUrl = seedBareRepo(rootDir);

  const electronArgs = [ELECTRON_LAUNCHER, APP_MAIN, '--headless', 'owner-serve'];
  if (process.platform === 'linux') {
    electronArgs.splice(1, 0, '--no-sandbox');
  }

  const chunks: string[] = [];
  const owner = spawn(process.execPath, electronArgs, {
    cwd: REPO_ROOT,
    env: ownerEnv({ homeDir, dbDir, socketPath, configPath }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  owner.stdout?.setEncoding('utf8');
  owner.stderr?.setEncoding('utf8');
  owner.stdout?.on('data', (chunk: string) => chunks.push(chunk));
  owner.stderr?.on('data', (chunk: string) => chunks.push(chunk));
  owner.on('exit', (code, signal) => {
    chunks.push(`\n[owner exited code=${code} signal=${signal}]\n`);
  });

  return {
    rootDir,
    homeDir,
    dbDir,
    socketPath,
    configPath,
    repoUrl,
    owner,
    ownerLog: () => chunks.join(''),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForOwner(fixture: OwnerFixture): Promise<void> {
  const startedAt = Date.now();
  let lastError = '';
  while (Date.now() - startedAt < OWNER_READY_TIMEOUT_MS) {
    const bus = new IpcBus(fixture.socketPath, { allowServe: false, requestDeadlineMs: 2_000 });
    try {
      await bus.ready();
      const response = await bus.request<Record<string, never>, { ok?: boolean }>('headless.owner-ping', {});
      if (response?.ok === true) return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      bus.disconnect();
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for throwaway owner: ${lastError}\nowner log:\n${fixture.ownerLog()}`);
}

function writePlan(fixture: OwnerFixture, index: number): { planName: string; planPath: string } {
  const planName = `Parallel Storm Repro ${index.toString().padStart(2, '0')}`;
  const planPath = join(fixture.rootDir, `p-${index}.yaml`);
  writeFileSync(planPath, [
    `name: ${planName}`,
    `repoUrl: ${fixture.repoUrl}`,
    'onFinish: none',
    'mergeMode: no_op',
    'baseBranch: main',
    'tasks:',
    `  - id: task-${index}`,
    `    description: Parallel storm task ${index}`,
    `    command: "printf 'parallel-storm-${index}\\\\n'"`,
    '',
  ].join('\n'));
  return { planName, planPath };
}

function parseWorkflowId(stdout: string): string | null {
  return /workflow:\s*(wf-[^\s]+)/.exec(stdout)?.[1] ?? null;
}

function outputReportsTimeout(output: string): boolean {
  return /timed out|timed-out|request_timeout|timeout timeoutMs=/i.test(output);
}

function runIntake(fixture: OwnerFixture, index: number): Promise<IntakeResult> {
  const { planName, planPath } = writePlan(fixture, index);
  const startedAt = performance.now();
  const child = spawn(RUN_SH, ['--headless', '--no-track', 'run', planPath], {
    cwd: REPO_ROOT,
    env: ownerEnv(fixture),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 1_000).unref();
    }, CLIENT_HARNESS_TIMEOUT_MS);
    timer.unref();

    child.on('exit', (exitCode) => {
      clearTimeout(timer);
      const combinedOutput = `${stdout}\n${stderr}`;
      resolve({
        planName,
        planPath,
        ackMs: performance.now() - startedAt,
        exitCode,
        workflowId: parseWorkflowId(stdout),
        stderr,
        stdout,
        timedOut: timedOut || outputReportsTimeout(combinedOutput),
      });
    });
  });
}

async function queryWorkflows(fixture: OwnerFixture): Promise<WorkflowRow[]> {
  const bus = new IpcBus(fixture.socketPath, { allowServe: false, requestDeadlineMs: 10_000 });
  try {
    await bus.ready();
    const response = await bus.request<{ kind: 'workflows' }, { workflows?: WorkflowRow[] }>(
      'headless.query',
      { kind: 'workflows' },
    );
    return response.workflows ?? [];
  } finally {
    bus.disconnect();
  }
}

function percentile95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
}

function countByPlanName(planNames: string[], workflows: WorkflowRow[]): Map<string, number> {
  const counts = new Map(planNames.map((name) => [name, 0]));
  for (const workflow of workflows) {
    if (!workflow.name || !counts.has(workflow.name)) continue;
    counts.set(workflow.name, (counts.get(workflow.name) ?? 0) + 1);
  }
  return counts;
}

function formatNames(names: string[]): string {
  return names.length > 0 ? names.join(', ') : 'none';
}

function formatFailures(results: IntakeResult[]): string {
  return results
    .filter((result) => result.exitCode !== 0 || result.timedOut)
    .map((result) => (
      `${result.planName}: exit=${result.exitCode} timedOut=${result.timedOut} `
      + `workflow=${result.workflowId ?? 'none'} stderr=${JSON.stringify(result.stderr.slice(0, 500))}`
    ))
    .join('\n');
}

async function stopOwner(fixture: OwnerFixture): Promise<void> {
  const markerPath = join(fixture.dbDir, 'invoker.db.owner');
  const pids = new Set<number>();
  if (existsSync(markerPath)) {
    const pid = Number(readFileSync(markerPath, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  if (fixture.owner.pid) pids.add(fixture.owner.pid);

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      console.error(`[submit-latency-parallel-storm] failed to SIGTERM owner pid=${pid}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const exited = await new Promise<boolean>((resolve) => {
    if (fixture.owner.exitCode !== null || fixture.owner.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), 3_000);
    fixture.owner.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

  if (!exited) {
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (err) {
        console.error(`[submit-latency-parallel-storm] failed to SIGKILL owner pid=${pid}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  try {
    rmSync(fixture.rootDir, { recursive: true, force: true });
  } catch (err) {
    console.error(`[submit-latency-parallel-storm] failed to remove temp dir ${fixture.rootDir}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

describe('parallel headless plan intake latency storm repro', () => {
  it('keeps 50 parallel intakes within the ack budget and stores each plan exactly once', async () => {
    const fixture = startOwner();
    try {
      await waitForOwner(fixture);

      const results = await Promise.all(
        Array.from({ length: STORM_SIZE }, (_, index) => runIntake(fixture, index)),
      );
      const workflows = await queryWorkflows(fixture);
      const planNames = results.map((result) => result.planName);
      const counts = countByPlanName(planNames, workflows);
      const lost = planNames.filter((name) => (counts.get(name) ?? 0) === 0);
      const doubled = planNames.filter((name) => (counts.get(name) ?? 0) > 1);
      const timedOut = results.filter((result) => result.timedOut).map((result) => result.planName);
      const nonZero = results.filter((result) => result.exitCode !== 0).map((result) => result.planName);
      const p95 = percentile95(results.map((result) => result.ackMs));
      const details = [
        `ack p95=${p95.toFixed(1)}ms`,
        `budget=${ACK_BUDGET_MS}ms`,
        `stored=${workflows.filter((workflow) => workflow.name && counts.has(workflow.name)).length}/${STORM_SIZE}`,
        `lost=[${formatNames(lost)}]`,
        `doubled=[${formatNames(doubled)}]`,
        `timedOut=[${formatNames(timedOut)}]`,
        `nonZero=[${formatNames(nonZero)}]`,
        `failures=${formatFailures(results) || 'none'}`,
      ].join('; ');

      console.error(`[submit-latency-parallel-storm] ${details}`);

      if (process.env.INVOKER_REPRO_EXPECT === 'bug') {
        expect(
          p95 > ACK_BUDGET_MS || lost.length > 0 || doubled.length > 0 || timedOut.length > 0,
          `expected current bug to breach budget or lose/duplicate/timeout work; ${details}`,
        ).toBe(true);
        return;
      }

      expect(p95, `parallel intake ack p95 exceeded budget; ${details}`).toBeLessThan(ACK_BUDGET_MS);
      expect(lost, `parallel intake lost plan names; ${details}`).toEqual([]);
      expect(doubled, `parallel intake duplicated plan names; ${details}`).toEqual([]);
      expect(nonZero, `parallel intake exited nonzero; ${details}`).toEqual([]);
      expect(timedOut, `parallel intake timed out; ${details}`).toEqual([]);
    } finally {
      await stopOwner(fixture);
    }
  }, 180_000);
});
