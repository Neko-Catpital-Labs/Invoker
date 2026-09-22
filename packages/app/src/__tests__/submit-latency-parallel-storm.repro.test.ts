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
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { IpcBus } from '@invoker/transport';

import { discoverOwner } from '../owner-endpoint.js';

const INTAKE_COUNT = 50;
const ACK_BUDGET_MS = 200;
const INTAKE_PROCESS_TIMEOUT_MS = 30_000;
const OWNER_READY_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 180_000;

const repoRoot = resolve(__dirname, '../../../..');
const appMainPath = join(repoRoot, 'packages/app/dist/main.js');
const headlessClientPath = join(repoRoot, 'packages/app/dist/headless-client.js');
const electronLauncherPath = join(repoRoot, 'scripts/electron.cjs');

type IntakeResult = {
  planName: string;
  ackMs: number;
  exitCode: number | null;
  workflowId: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type ProcessResult = {
  elapsedMs: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  killedByTimeout: boolean;
};

type Fixture = {
  tmpDir: string;
  homeDir: string;
  dbDir: string;
  socketPath: string;
  configPath: string;
  repoUrl: string;
  childEnv: NodeJS.ProcessEnv;
  owner?: ChildProcess;
  ownerLog: string;
};

let activeFixture: Fixture | undefined;

function ensureBuiltApp(): void {
  if (existsSync(appMainPath) && existsSync(headlessClientPath)) return;
  execFileSync('pnpm', ['--filter', '@invoker/app', 'build'], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
    timeout: 120_000,
  });
}

function git(args: string[]): void {
  execFileSync('git', args, { cwd: repoRoot, stdio: 'ignore' });
}

function createFixture(): Fixture {
  const tmpDir = mkdtempSync(join(tmpdir(), 'invoker-parallel-storm-'));
  const homeDir = join(tmpDir, 'home');
  const dbDir = join(homeDir, '.invoker');
  const socketPath = join(tmpDir, 'ipc-transport.sock');
  const configPath = join(tmpDir, 'config.json');
  const remoteRepo = join(tmpDir, 'remote.git');
  const seedRepo = join(tmpDir, 'seed-repo');

  mkdirSync(dbDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, maxConcurrency: 1 }));

  git(['init', '--bare', remoteRepo]);
  git(['init', seedRepo]);
  git(['-C', seedRepo, 'config', 'user.email', 'parallel-storm@example.invalid']);
  git(['-C', seedRepo, 'config', 'user.name', 'Parallel Storm Repro']);
  writeFileSync(join(seedRepo, 'README.md'), 'parallel storm repro repository\n');
  git(['-C', seedRepo, 'add', 'README.md']);
  git(['-C', seedRepo, 'commit', '-m', 'seed repro repository']);
  git(['-C', seedRepo, 'branch', '-M', 'main']);
  git(['-C', seedRepo, 'remote', 'add', 'origin', remoteRepo]);
  git(['-C', seedRepo, 'push', 'origin', 'main']);

  const profileId = `parallel-storm-${process.pid}-${Date.now()}`;
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    XDG_CONFIG_HOME: join(homeDir, '.config'),
    NODE_ENV: 'test',
    INVOKER_RUNTIME_KIND: 'source-development',
    INVOKER_DEVELOPMENT_PROFILE: '1',
    INVOKER_DEVELOPMENT_PROFILE_ACTIVE: '1',
    INVOKER_SOURCE_ROOT: repoRoot,
    INVOKER_PROFILE_ID: profileId,
    INVOKER_DB_DIR: dbDir,
    INVOKER_USER_DATA_DIR: join(tmpDir, 'electron-user-data'),
    INVOKER_IPC_SOCKET: socketPath,
    INVOKER_REPO_CONFIG_PATH: configPath,
    INVOKER_ENV_PATH: join(tmpDir, '.env'),
    INVOKER_LOG_PATH: join(tmpDir, 'invoker.log'),
    INVOKER_API_PORT: '0',
    INVOKER_WEB_PORT: '0',
    INVOKER_E2E_HIDE_WINDOW: '1',
    INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS: '600000',
    INVOKER_STARTUP_POLL_DELAY_MS: '0',
    INVOKER_SKIP_BOOTSTRAP_CHECK: '1',
  };

  return {
    tmpDir,
    homeDir,
    dbDir,
    socketPath,
    configPath,
    repoUrl: pathToFileURL(remoteRepo).href,
    childEnv,
    ownerLog: '',
  };
}

function appendOwnerLog(fixture: Fixture, chunk: unknown): void {
  fixture.ownerLog = `${fixture.ownerLog}${String(chunk)}`.slice(-200_000);
}

function startOwner(fixture: Fixture): void {
  const electronArgs = [electronLauncherPath, appMainPath, '--headless', 'owner-serve'];
  if (process.platform === 'linux') electronArgs.splice(1, 0, '--no-sandbox');

  fixture.owner = spawn(process.execPath, electronArgs, {
    cwd: repoRoot,
    env: {
      ...fixture.childEnv,
      INVOKER_HEADLESS_STANDALONE: '1',
      LIBGL_ALWAYS_SOFTWARE: process.platform === 'linux' ? '1' : process.env.LIBGL_ALWAYS_SOFTWARE,
    },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  fixture.owner.stdout?.setEncoding('utf8');
  fixture.owner.stderr?.setEncoding('utf8');
  fixture.owner.stdout?.on('data', (chunk) => appendOwnerLog(fixture, chunk));
  fixture.owner.stderr?.on('data', (chunk) => appendOwnerLog(fixture, chunk));
  fixture.owner.on('error', (error) => appendOwnerLog(fixture, `\n[owner error: ${error.message}]\n`));
  fixture.owner.on('exit', (code, signal) => {
    appendOwnerLog(fixture, `\n[owner launcher exited code=${code} signal=${signal}]\n`);
  });
}

async function waitForOwner(fixture: Fixture): Promise<void> {
  const deadline = Date.now() + OWNER_READY_TIMEOUT_MS;
  let lastError = 'owner did not answer';
  while (Date.now() < deadline) {
    if (fixture.owner?.exitCode !== null) {
      throw new Error(`throwaway owner exited before becoming ready\n${fixture.ownerLog}`);
    }
    const bus = new IpcBus(fixture.socketPath, { allowServe: false });
    try {
      await bus.ready();
      const owner = await discoverOwner(bus, 1_000);
      if (owner?.canAcceptStandaloneMutations) return;
      lastError = owner?.buildMismatchReason ?? 'owner was reachable but could not accept mutations';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      bus.disconnect();
    }
    await delay(100);
  }
  throw new Error(
    `timed out waiting for throwaway owner: ${lastError}\nowner log:\n${fixture.ownerLog}`,
  );
}

function writePlans(fixture: Fixture): Array<{ name: string; path: string }> {
  return Array.from({ length: INTAKE_COUNT }, (_, index) => {
    const suffix = String(index + 1).padStart(2, '0');
    const name = `Parallel Storm ${process.pid}-${suffix}`;
    const planPath = join(fixture.tmpDir, `parallel-storm-${suffix}.yaml`);
    writeFileSync(planPath, [
      `name: ${name}`,
      `repoUrl: ${fixture.repoUrl}`,
      'baseBranch: main',
      'onFinish: none',
      'tasks:',
      `  - id: intake-${suffix}`,
      `    description: Parallel intake ${suffix}`,
      '    command: "true"',
      '    requiresManualApproval: true',
      '',
    ].join('\n'));
    return { name, path: planPath };
  });
}

function runProcess(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<ProcessResult> {
  return new Promise((resolveResult) => {
    const startedAt = performance.now();
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killedByTimeout = false;
    let spawnError: Error | undefined;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { spawnError = error; });
    const timeout = setTimeout(() => {
      killedByTimeout = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (exitCode) => {
      clearTimeout(timeout);
      if (spawnError) stderr += `\nspawn error: ${spawnError.message}\n`;
      resolveResult({
        elapsedMs: performance.now() - startedAt,
        exitCode,
        stdout,
        stderr,
        killedByTimeout,
      });
    });
  });
}

async function submitPlan(
  fixture: Fixture,
  plan: { name: string; path: string },
): Promise<IntakeResult> {
  const result = await runProcess(
    [headlessClientPath, '--no-track', 'run', plan.path],
    {
      ...fixture.childEnv,
      INVOKER_HEADLESS_REQUIRE_EXISTING_OWNER: '1',
    },
    INTAKE_PROCESS_TIMEOUT_MS,
  );
  const workflowId = result.stdout.match(/Delegated to owner — workflow: (wf-[^\s]+)/)?.[1] ?? null;
  const timedOut = result.killedByTimeout
    || (result.exitCode !== 0 && /timed?\s*out|timeout/i.test(result.stderr));
  return {
    planName: plan.name,
    ackMs: result.elapsedMs,
    exitCode: result.exitCode,
    workflowId,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut,
  };
}

async function readOwnerWorkflows(fixture: Fixture): Promise<Array<{ name?: string }>> {
  const result = await runProcess(
    [headlessClientPath, 'query', 'workflows', '--output', 'json'],
    fixture.childEnv,
    60_000,
  );
  if (result.exitCode !== 0 || result.killedByTimeout) {
    throw new Error(
      `throwaway owner workflow query failed (exit=${result.exitCode}, timeout=${result.killedByTimeout})\n` +
      `stdout:\n${result.stdout}\nstderr:\n${result.stderr}\nowner log:\n${fixture.ownerLog}`,
    );
  }
  const parsed = JSON.parse(result.stdout.trim()) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`expected workflow query to return an array, got: ${result.stdout}`);
  }
  return parsed as Array<{ name?: string }>;
}

function percentile95(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}

function readOwnerPid(fixture: Fixture): number | undefined {
  const markerPath = join(fixture.dbDir, 'invoker.db.owner');
  if (!existsSync(markerPath)) return undefined;
  const raw = readFileSync(markerPath, 'utf8').trim();
  return /^[1-9]\d*$/.test(raw) ? Number(raw) : undefined;
}

function signalOwnerGroup(fixture: Fixture, signal: NodeJS.Signals): void {
  const launcherPid = fixture.owner?.pid;
  if (launcherPid) {
    if (process.platform === 'win32') fixture.owner?.kill(signal);
    else process.kill(-launcherPid, signal);
    return;
  }
  const ownerPid = readOwnerPid(fixture);
  if (ownerPid) process.kill(ownerPid, signal);
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  try {
    signalOwnerGroup(fixture, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      console.error(`[parallel-storm cleanup] SIGTERM failed: ${String(error)}`);
    }
  }
  await delay(750);
  try {
    signalOwnerGroup(fixture, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      console.error(`[parallel-storm cleanup] SIGKILL failed: ${String(error)}`);
    }
  }
  await delay(100);
  try {
    rmSync(fixture.tmpDir, { recursive: true, force: true });
  } catch (error) {
    console.error(`[parallel-storm cleanup] failed to remove ${fixture.tmpDir}: ${String(error)}`);
  }
}

afterAll(async () => {
  if (!activeFixture) return;
  await cleanupFixture(activeFixture);
  activeFixture = undefined;
});

describe('parallel plan intake latency storm', () => {
  it(
    `acknowledges and stores ${INTAKE_COUNT} simultaneous one-task plans within ${ACK_BUDGET_MS}ms p95`,
    async () => {
      ensureBuiltApp();
      const fixture = createFixture();
      activeFixture = fixture;
      try {
        startOwner(fixture);
        await waitForOwner(fixture);
        const plans = writePlans(fixture);

        const intakes = await Promise.all(plans.map((plan) => submitPlan(fixture, plan)));
        const workflows = await readOwnerWorkflows(fixture);
        const counts = new Map<string, number>();
        for (const workflow of workflows) {
          if (workflow.name) counts.set(workflow.name, (counts.get(workflow.name) ?? 0) + 1);
        }

        const p95 = percentile95(intakes.map((intake) => intake.ackMs));
        const lost = plans.filter((plan) => (counts.get(plan.name) ?? 0) === 0).map((plan) => plan.name);
        const doubled = plans
          .filter((plan) => (counts.get(plan.name) ?? 0) > 1)
          .map((plan) => `${plan.name}=${counts.get(plan.name)}`);
        const timedOut = intakes.filter((intake) => intake.timedOut).map((intake) => intake.planName);
        const failed = intakes
          .filter((intake) => intake.exitCode !== 0)
          .map((intake) => `${intake.planName}=${intake.exitCode}`);
        const missingWorkflowIds = intakes
          .filter((intake) => intake.workflowId === null)
          .map((intake) => intake.planName);
        const report = [
          `ack p95=${p95.toFixed(1)}ms`,
          `budget=${ACK_BUDGET_MS}ms`,
          `lost=[${lost.join(', ')}]`,
          `doubled=[${doubled.join(', ')}]`,
          `timedOut=[${timedOut.join(', ')}]`,
          `failed=[${failed.join(', ')}]`,
          `missingWorkflowIds=[${missingWorkflowIds.join(', ')}]`,
        ].join(' ');
        console.error(`[submit-latency-parallel-storm] ${report}`);

        if (process.env.INVOKER_REPRO_EXPECT === 'bug') {
          const defectObserved = p95 > ACK_BUDGET_MS
            || lost.length > 0
            || doubled.length > 0
            || timedOut.length > 0;
          expect(defectObserved, `expected the current parallel-intake defect: ${report}`).toBe(true);
        } else {
          expect(p95, `parallel intake acknowledgment exceeded budget: ${report}`).toBeLessThan(ACK_BUDGET_MS);
          expect(lost, `plan names were lost: ${report}`).toEqual([]);
          expect(doubled, `plan names were stored more than once: ${report}`).toEqual([]);
          expect(failed, `intake processes failed: ${report}`).toEqual([]);
        }
      } finally {
        await cleanupFixture(fixture);
        activeFixture = undefined;
      }
    },
    TEST_TIMEOUT_MS,
  );
});
