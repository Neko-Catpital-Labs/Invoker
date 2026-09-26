import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { IpcBus } from '@invoker/transport';
import { beforeAll, describe, expect, it } from 'vitest';

const INTAKE_COUNT = 50;
const ACK_P95_BUDGET_MS = 200;
const CLIENT_TIMEOUT_MS = 20_000;
const OWNER_READY_TIMEOUT_MS = 60_000;
const BUILD_TIMEOUT_MS = 180_000;
const GIT_SETUP_TIMEOUT_MS = 10_000;

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '../../../..');
const appMain = join(repoRoot, 'packages/app/dist/main.js');
const headlessClient = join(repoRoot, 'packages/app/dist/headless-client.js');
const electronBinary = createRequire(import.meta.url)('electron') as string;

type IntakeResult = {
  planName: string;
  ackMs: number;
  exitCode: number | null;
  workflowId: string | undefined;
  stderr: string;
  stdout: string;
  timedOut: boolean;
};

type StoredWorkflow = {
  id: string;
  name: string;
};

function ensureBuiltApp(): void {
  if (existsSync(appMain) && existsSync(headlessClient)) return;
  execFileSync('pnpm', ['--filter', '@invoker/app', 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
    timeout: BUILD_TIMEOUT_MS,
  });
}

function runGit(args: string[]): void {
  execFileSync('git', args, { stdio: 'ignore', timeout: GIT_SETUP_TIMEOUT_MS });
}

function initializeBareRepo(rootDir: string): string {
  const bareRepo = join(rootDir, 'remote.git');
  const seedRepo = join(rootDir, 'seed-repo');
  runGit(['init', '--bare', bareRepo]);
  runGit(['init', seedRepo]);
  runGit(['-C', seedRepo, 'config', 'user.email', 'repro@example.invalid']);
  runGit(['-C', seedRepo, 'config', 'user.name', 'Repro Runner']);
  writeFileSync(join(seedRepo, 'README.md'), 'parallel intake storm repro\n');
  runGit(['-C', seedRepo, 'add', 'README.md']);
  runGit(['-C', seedRepo, 'commit', '-m', 'seed repro repository']);
  runGit(['-C', seedRepo, 'branch', '-M', 'main']);
  runGit(['-C', seedRepo, 'remote', 'add', 'origin', bareRepo]);
  runGit(['-C', seedRepo, 'push', 'origin', 'main']);
  return pathToFileURL(bareRepo).href;
}

function writePlan(rootDir: string, repoUrl: string, index: number): { path: string; name: string } {
  const name = `Parallel Intake Storm ${String(index + 1).padStart(2, '0')}`;
  const path = join(rootDir, `storm-${index + 1}.yaml`);
  writeFileSync(path, [
    `name: ${name}`,
    `repoUrl: ${repoUrl}`,
    'onFinish: none',
    'mergeMode: no_op',
    'baseBranch: main',
    'tasks:',
    `  - id: intake-${index + 1}`,
    `    description: Parallel intake ${index + 1}`,
    '    command: "true"',
    '    requiresManualApproval: true',
    '',
  ].join('\n'));
  return { path, name };
}

function parseWorkflowId(stdout: string): string | undefined {
  return stdout.match(/(?:Delegated to owner — workflow:|Workflow ID:)\s+(wf-[^\s]+)/)?.[1];
}

async function runClient(
  args: string[],
  env: NodeJS.ProcessEnv,
  planName: string,
  timeoutMs = CLIENT_TIMEOUT_MS,
): Promise<IntakeResult> {
  const startedAt = performance.now();
  return await new Promise<IntakeResult>((resolveResult) => {
    const child = spawn(process.execPath, [headlessClient, ...args], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let hardTimedOut = false;
    let spawnError: Error | undefined;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => { spawnError = error; });

    const timer = setTimeout(() => {
      hardTimedOut = true;
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
      killTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();

    child.once('close', (exitCode) => {
      clearTimeout(timer);
      if (spawnError) stderr += `\nspawn error: ${spawnError.message}`;
      resolveResult({
        planName,
        ackMs: performance.now() - startedAt,
        exitCode,
        workflowId: parseWorkflowId(stdout),
        stderr,
        stdout,
        timedOut: hardTimedOut
          || /\[delegation\][^\n]* timeout channel=|timed out (?:after|waiting)|request_timeout/i.test(stderr),
      });
    });
  });
}

function startOwner(env: NodeJS.ProcessEnv): { child: ChildProcess; readLog: () => string } {
  const electronArgs = [appMain, '--headless', 'owner-serve'];
  if (process.platform === 'linux') electronArgs.unshift('--no-sandbox');
  const child = spawn(electronBinary, electronArgs, {
    cwd: repoRoot,
    env: { ...env, INVOKER_HEADLESS_STANDALONE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { log += chunk; });
  child.stderr?.on('data', (chunk: string) => { log += chunk; });
  child.once('error', (error) => { log += `\nowner spawn error: ${error.message}\n`; });
  child.once('exit', (code, signal) => { log += `\nowner exited code=${code} signal=${signal}\n`; });
  return { child, readLog: () => log };
}

async function waitForOwner(socketPath: string, owner: ChildProcess, readLog: () => string): Promise<IpcBus> {
  const bus = new IpcBus(socketPath, { allowServe: false, requestDeadlineMs: 1_000 });
  const deadline = Date.now() + OWNER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (owner.exitCode !== null || owner.signalCode !== null) {
      bus.disconnect();
      throw new Error(`Throwaway owner exited before it became ready.\n${readLog()}`);
    }
    try {
      await bus.ready();
      const response = await bus.request<Record<string, never>, { ok?: boolean }>('headless.owner-ping', {});
      if (response?.ok) return bus;
    } catch {
      // The socket or handler can be absent while the built owner is starting.
    }
    await delay(100);
  }
  bus.disconnect();
  throw new Error(`Timed out waiting for throwaway owner.\n${readLog()}`);
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await Promise.race([
    once(child, 'exit').then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
}

async function stopOwner(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (await waitForExit(child, 5_000)) return;
  child.kill('SIGKILL');
  if (!(await waitForExit(child, 2_000))) {
    throw new Error(`throwaway owner pid=${child.pid ?? 'unknown'} did not exit after SIGKILL`);
  }
}

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function formatNames(names: string[]): string {
  return names.length > 0 ? names.join(', ') : 'none';
}

describe('parallel plan intake latency storm (repro)', () => {
  beforeAll(() => {
    ensureBuiltApp();
  }, BUILD_TIMEOUT_MS);

  it('stores 50 simultaneous plan intakes exactly once inside the ack budget', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'invoker-parallel-intake-storm-'));
    const homeDir = join(rootDir, 'home');
    const dbDir = join(rootDir, 'db');
    const socketPath = join(rootDir, 'owner.sock');
    const configPath = join(rootDir, 'config.json');
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, maxConcurrency: 1 }));

    const profileId = basename(rootDir);
    const commonEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: homeDir,
      XDG_CONFIG_HOME: join(rootDir, 'xdg-config'),
      INVOKER_RUNTIME_KIND: 'source-development',
      INVOKER_DEVELOPMENT_PROFILE: '1',
      INVOKER_DEVELOPMENT_PROFILE_ACTIVE: '1',
      INVOKER_SOURCE_ROOT: repoRoot,
      INVOKER_PROFILE_ID: profileId,
      INVOKER_DB_DIR: dbDir,
      INVOKER_USER_DATA_DIR: join(rootDir, 'electron-user-data'),
      INVOKER_IPC_SOCKET: socketPath,
      INVOKER_REPO_CONFIG_PATH: configPath,
      INVOKER_ENV_PATH: join(rootDir, '.env'),
      INVOKER_LOG_PATH: join(rootDir, 'invoker.log'),
      INVOKER_API_PORT: '0',
      INVOKER_WEB_PORT: '0',
      INVOKER_SKIP_BOOTSTRAP_CHECK: '1',
      INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS: '600000',
      INVOKER_STARTUP_POLL_DELAY_MS: '0',
      NODE_ENV: 'test',
      TZ: 'UTC',
    };
    const clientEnv = {
      ...commonEnv,
      INVOKER_HEADLESS_REQUIRE_EXISTING_OWNER: '1',
    };

    const owner = startOwner(commonEnv);
    let ownerBus: IpcBus | undefined;
    try {
      const repoUrl = initializeBareRepo(rootDir);
      const plans = Array.from({ length: INTAKE_COUNT }, (_, index) => writePlan(rootDir, repoUrl, index));
      ownerBus = await waitForOwner(socketPath, owner.child, owner.readLog);

      const intakes = await Promise.all(plans.map((plan) => (
        runClient(['--no-track', 'run', plan.path], clientEnv, plan.name)
      )));

      const query = await runClient(
        ['query', 'workflows', '--output', 'json'],
        clientEnv,
        'workflow-query',
        60_000,
      );
      if (query.exitCode !== 0) {
        throw new Error(
          `Failed to read workflows from throwaway owner: exit=${query.exitCode} stdout=${JSON.stringify(query.stdout)} stderr=${JSON.stringify(query.stderr)}\nowner log:\n${owner.readLog()}`,
        );
      }
      const workflows = JSON.parse(query.stdout) as StoredWorkflow[];
      const storedCountByName = new Map(plans.map(({ name }) => [name, 0]));
      for (const workflow of workflows) {
        if (storedCountByName.has(workflow.name)) {
          storedCountByName.set(workflow.name, storedCountByName.get(workflow.name)! + 1);
        }
      }

      const ackP95 = p95(intakes.map((intake) => intake.ackMs));
      const lostNames = plans.map(({ name }) => name).filter((name) => storedCountByName.get(name) === 0);
      const doubledNames = plans.map(({ name }) => name).filter((name) => (storedCountByName.get(name) ?? 0) > 1);
      const timedOutNames = intakes.filter((intake) => intake.timedOut).map((intake) => intake.planName);
      const nonZeroIntakes = intakes.filter((intake) => intake.exitCode !== 0);
      const missingWorkflowIds = intakes.filter((intake) => intake.workflowId === undefined).map((intake) => intake.planName);
      const failedDetails = nonZeroIntakes.map((intake) => (
        `${intake.planName}: exit=${intake.exitCode} ack=${intake.ackMs.toFixed(1)}ms workflowId=${intake.workflowId ?? 'none'} stderr=${JSON.stringify(intake.stderr)}`
      ));
      const measurement = [
        `ack p95=${ackP95.toFixed(1)}ms budget=${ACK_P95_BUDGET_MS}ms`,
        `lost=${formatNames(lostNames)}`,
        `doubled=${formatNames(doubledNames)}`,
        `timedOut=${formatNames(timedOutNames)}`,
        `nonZero=${formatNames(nonZeroIntakes.map((intake) => intake.planName))}`,
        `missingWorkflowId=${formatNames(missingWorkflowIds)}`,
        `stored=${plans.length - lostNames.length}/${plans.length}`,
        ...(failedDetails.length > 0 ? [`intake failures:\n${failedDetails.join('\n')}`] : []),
      ].join('; ');
      console.error(`[submit-latency-parallel-storm] ${measurement}`);

      if (process.env.INVOKER_REPRO_EXPECT === 'bug') {
        const observedDefect = ackP95 > ACK_P95_BUDGET_MS
          || lostNames.length > 0
          || doubledNames.length > 0
          || timedOutNames.length > 0;
        expect(observedDefect, `expected current parallel intake defect; ${measurement}`).toBe(true);
        return;
      }

      expect(ackP95, measurement).toBeLessThan(ACK_P95_BUDGET_MS);
      expect(lostNames, measurement).toEqual([]);
      expect(doubledNames, measurement).toEqual([]);
      expect(nonZeroIntakes, measurement).toEqual([]);
    } finally {
      ownerBus?.disconnect();
      try {
        await stopOwner(owner.child);
      } catch (error) {
        console.error(`[submit-latency-parallel-storm] owner cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        rmSync(rootDir, { recursive: true, force: true });
      } catch (error) {
        console.error(`[submit-latency-parallel-storm] temp cleanup failed for ${rootDir}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }, 180_000);
});
