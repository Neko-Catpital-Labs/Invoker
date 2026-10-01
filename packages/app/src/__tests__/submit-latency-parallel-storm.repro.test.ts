import { execFileSync, spawn } from 'node:child_process';
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

import { SQLiteAdapter } from '@invoker/data-store';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const RUN_SH = join(REPO_ROOT, 'run.sh');
const HEADLESS_CLIENT = join(REPO_ROOT, 'packages', 'app', 'dist', 'headless-client.js');
const INTAKE_COUNT = 50;
const ACK_BUDGET_MS = 200;
const CONTROLLED_REPRO_RUN = process.env.INVOKER_REPRO_EXPECT === 'bug' || process.env.INVOKER_REPRO_EXPECT === 'fixed';
const BOOTSTRAP_TIMEOUT_MS = 60_000;
const CLIENT_TIMEOUT_MS = 30_000;
const QUERY_TIMEOUT_MS = 30_000;

type CommandResult = {
  ackMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type IntakeResult = CommandResult & {
  name: string;
  workflowId: string | null;
};

type Fixture = {
  tmpDir: string;
  homeDir: string;
  dbDir: string;
  dbPath: string;
  ipcSocket: string;
  configPath: string;
  repoUrl: string;
  ownerPid?: number;
};

type StoredWorkflow = {
  name?: string;
};

function cleanEnv(fixture: Fixture): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.INVOKER_HEADLESS_STANDALONE;
  env.HOME = fixture.homeDir;
  env.INVOKER_DB_DIR = fixture.dbDir;
  env.INVOKER_IPC_SOCKET = fixture.ipcSocket;
  env.INVOKER_REPO_CONFIG_PATH = fixture.configPath;
  env.INVOKER_SKIP_BOOTSTRAP_CHECK = '1';
  env.INVOKER_ENABLE_WORKSPACE_CLEANUP = '0';
  return env;
}

function ensureBuiltApp(): void {
  if (existsSync(HEADLESS_CLIENT)) return;
  execFileSync('pnpm', ['--filter', '@invoker/app', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
}

function seedBareRepo(tmpDir: string): string {
  const remoteRepo = join(tmpDir, 'remote.git');
  const seedRepo = join(tmpDir, 'seed-repo');
  execFileSync('git', ['init', '--bare', remoteRepo], { stdio: 'ignore' });
  execFileSync('git', ['init', seedRepo], { stdio: 'ignore' });
  execFileSync('git', ['-C', seedRepo, 'config', 'user.email', 'parallel-storm@example.invalid']);
  execFileSync('git', ['-C', seedRepo, 'config', 'user.name', 'Parallel Storm Repro']);
  writeFileSync(join(seedRepo, 'README.md'), 'parallel storm repro repository\n', 'utf8');
  execFileSync('git', ['-C', seedRepo, 'add', 'README.md'], { stdio: 'ignore' });
  execFileSync('git', ['-C', seedRepo, 'commit', '-m', 'seed parallel storm repository'], { stdio: 'ignore' });
  execFileSync('git', ['-C', seedRepo, 'branch', '-M', 'main'], { stdio: 'ignore' });
  execFileSync('git', ['-C', seedRepo, 'remote', 'add', 'origin', remoteRepo], { stdio: 'ignore' });
  execFileSync('git', ['-C', seedRepo, 'push', 'origin', 'main'], { stdio: 'ignore' });
  return pathToFileURL(remoteRepo).href;
}

function createFixture(): Fixture {
  const tmpDir = mkdtempSync(join(tmpdir(), 'submit-latency-parallel-storm-'));
  const homeDir = join(tmpDir, 'home');
  const dbDir = join(tmpDir, 'db');
  const configPath = join(tmpDir, 'config.json');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(dbDir, { recursive: true });
  writeFileSync(configPath, '{"autoFixRetries":0,"maxConcurrency":1}\n', 'utf8');
  return {
    tmpDir,
    homeDir,
    dbDir,
    dbPath: join(dbDir, 'invoker.db'),
    ipcSocket: join(tmpDir, 'ipc-transport.sock'),
    configPath,
    repoUrl: seedBareRepo(tmpDir),
  };
}

function writePlan(fixture: Fixture, name: string): string {
  const planPath = join(fixture.tmpDir, `${name}.yaml`);
  writeFileSync(
    planPath,
    [
      `name: ${name}`,
      `repoUrl: ${fixture.repoUrl}`,
      'onFinish: none',
      'baseBranch: main',
      'tasks:',
      '  - id: root',
      `    description: ${name} root task`,
      `    command: "printf '${name}\\\\n'"`,
      '    requiresManualApproval: true',
      '',
    ].join('\n'),
    'utf8',
  );
  return planPath;
}

function runCommand(args: string[], fixture: Fixture, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const startedAt = performance.now();
    const child = spawn(RUN_SH, args, {
      cwd: REPO_ROOT,
      env: cleanEnv(fixture),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      stderr += `${error instanceof Error ? error.message : String(error)}\n`;
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise({
        ackMs: performance.now() - startedAt,
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

function parseWorkflowId(stdout: string): string | null {
  const match = /(?:Workflow ID:\s*|workflow:\s*)(wf-[^\s]+)/.exec(stdout);
  return match?.[1] ?? null;
}

function readOwnerPid(fixture: Fixture): number | null {
  const markerPath = `${fixture.dbPath}.owner`;
  if (!existsSync(markerPath)) return null;
  const pid = Number.parseInt(readFileSync(markerPath, 'utf8').trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function ownerPidIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const command = execFileSync('ps', ['-p', String(pid), '-ww', '-o', 'command='], { encoding: 'utf8' });
    return command.includes('--headless') && command.includes('owner-serve');
  } catch {
    return true;
  }
}

async function waitForOwnerExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!ownerPidIsLive(pid)) return;
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 100));
  }
}

async function stopOwner(fixture: Fixture): Promise<void> {
  const pids = new Set<number>();
  if (fixture.ownerPid !== undefined) pids.add(fixture.ownerPid);
  const markerPid = readOwnerPid(fixture);
  if (markerPid !== null) pids.add(markerPid);

  for (const pid of pids) {
    try {
      if (!ownerPidIsLive(pid)) continue;
      process.kill(pid, 'SIGTERM');
      await waitForOwnerExit(pid);
      if (ownerPidIsLive(pid)) {
        process.kill(pid, 'SIGKILL');
        await waitForOwnerExit(pid);
      }
    } catch (error) {
      console.error(`[submit-latency-parallel-storm] failed to stop owner pid=${pid}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function cleanup(fixture: Fixture): Promise<void> {
  await stopOwner(fixture);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(fixture.tmpDir, { recursive: true, force: true });
      return;
    } catch (error) {
      console.error(`[submit-latency-parallel-storm] cleanup attempt ${attempt + 1} failed: ${error instanceof Error ? error.message : String(error)}`);
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 300));
    }
  }
}

async function startThrowawayOwner(fixture: Fixture): Promise<void> {
  const bootstrapName = 'Parallel Storm Bootstrap Blocker';
  const bootstrapPlan = writePlan(fixture, bootstrapName);
  const result = await runCommand(['--headless', '--no-track', 'run', bootstrapPlan], fixture, BOOTSTRAP_TIMEOUT_MS);
  const workflowId = parseWorkflowId(result.stdout);
  const ownerPid = readOwnerPid(fixture);
  const measured = `bootstrap exit=${result.exitCode ?? 'signal:' + result.signal} timedOut=${result.timedOut} ack=${result.ackMs.toFixed(1)}ms workflowId=${workflowId ?? '<none>'} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`;
  expect(result.exitCode, measured).toBe(0);
  expect(workflowId, measured).toMatch(/^wf-/);
  expect(ownerPid, measured).not.toBeNull();
  expect(ownerPidIsLive(ownerPid!), measured).toBe(true);
  fixture.ownerPid = ownerPid!;
}

function percentile(values: number[], percent: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percent / 100) - 1)] ?? 0;
}

function formatNames(names: string[]): string {
  return names.length === 0 ? 'none' : names.join(',');
}

async function queryWorkflowsFromOwner(fixture: Fixture): Promise<StoredWorkflow[]> {
  const result = await runCommand(['--headless', 'query', 'workflows', '--output', 'json'], fixture, QUERY_TIMEOUT_MS);
  const start = result.stdout.indexOf('[');
  const measured = `query exit=${result.exitCode ?? 'signal:' + result.signal} timedOut=${result.timedOut} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`;
  expect(result.exitCode, measured).toBe(0);
  expect(start, measured).toBeGreaterThanOrEqual(0);
  return JSON.parse(result.stdout.slice(start)) as StoredWorkflow[];
}

async function readWorkflowsFromDb(fixture: Fixture): Promise<StoredWorkflow[]> {
  const adapter = await SQLiteAdapter.create(fixture.dbPath, { readOnly: true });
  try {
    return adapter.listWorkflows().map((workflow) => ({ name: workflow.name }));
  } finally {
    adapter.close();
  }
}

function summarize(
  intakes: IntakeResult[],
  expectedNames: string[],
  storedCounts: Map<string, number>,
): {
  measured: string;
  p95: number;
  lostNames: string[];
  doubledNames: string[];
  timedOutNames: string[];
  nonZeroNames: string[];
} {
  const p95 = percentile(intakes.map((intake) => intake.ackMs), 95);
  const lostNames = expectedNames.filter((name) => (storedCounts.get(name) ?? 0) === 0);
  const doubledNames = expectedNames.filter((name) => (storedCounts.get(name) ?? 0) > 1);
  const timedOutNames = intakes.filter((intake) => intake.timedOut).map((intake) => intake.name);
  const nonZeroNames = intakes
    .filter((intake) => intake.exitCode !== 0)
    .map((intake) => `${intake.name}:${intake.exitCode ?? intake.signal ?? 'null'}`);
  const failedDetails = intakes
    .filter((intake) => intake.exitCode !== 0 || intake.timedOut)
    .slice(0, 10)
    .map((intake) => `${intake.name}{exit=${intake.exitCode ?? 'signal:' + intake.signal},timedOut=${intake.timedOut},ack=${intake.ackMs.toFixed(1)}ms,workflowId=${intake.workflowId ?? '<none>'},stderr=${JSON.stringify(intake.stderr)}}`);
  const measured = [
    `p95=${p95.toFixed(1)}ms`,
    `budget=${ACK_BUDGET_MS}ms`,
    `lost=${formatNames(lostNames)}`,
    `doubled=${formatNames(doubledNames)}`,
    `timedOut=${formatNames(timedOutNames)}`,
    `nonZero=${formatNames(nonZeroNames)}`,
    `failedDetails=${failedDetails.length === 0 ? 'none' : failedDetails.join(' ')}`,
  ].join(' ');
  return { measured, p95, lostNames, doubledNames, timedOutNames, nonZeroNames };
}

describe.skipIf(!CONTROLLED_REPRO_RUN)('headless run intake latency under a 50-client parallel storm (repro)', () => {
  it('stores each parallel intake exactly once within the ack budget', async () => {
    ensureBuiltApp();
    const fixture = createFixture();
    try {
      await startThrowawayOwner(fixture);

      const planNames = Array.from(
        { length: INTAKE_COUNT },
        (_, index) => `Parallel Storm Intake ${String(index + 1).padStart(2, '0')}`,
      );
      const planPaths = planNames.map((name) => writePlan(fixture, name));
      const intakes = await Promise.all(planPaths.map(async (planPath, index): Promise<IntakeResult> => {
        const result = await runCommand(['--headless', '--no-track', 'run', planPath], fixture, CLIENT_TIMEOUT_MS);
        return {
          ...result,
          name: planNames[index]!,
          workflowId: parseWorkflowId(result.stdout),
        };
      }));

      let workflows: StoredWorkflow[];
      try {
        workflows = await queryWorkflowsFromOwner(fixture);
      } catch (error) {
        console.error(`[submit-latency-parallel-storm] owner query failed, falling back to temp DB after owner stop: ${error instanceof Error ? error.message : String(error)}`);
        await stopOwner(fixture);
        workflows = await readWorkflowsFromDb(fixture);
      }
      const storedCounts = new Map<string, number>();
      for (const workflow of workflows) {
        if (workflow.name) storedCounts.set(workflow.name, (storedCounts.get(workflow.name) ?? 0) + 1);
      }

      const {
        measured,
        p95,
        lostNames,
        doubledNames,
        timedOutNames,
        nonZeroNames,
      } = summarize(intakes, planNames, storedCounts);
      console.error(`[submit-latency-parallel-storm] ${measured}`);

      if (process.env.INVOKER_REPRO_EXPECT === 'bug') {
        const hasDefect = p95 > ACK_BUDGET_MS
          || lostNames.length > 0
          || doubledNames.length > 0
          || timedOutNames.length > 0;
        expect(hasDefect, `expected current bug to breach the parallel intake budget or lose/duplicate work; ${measured}`).toBe(true);
        return;
      }

      expect(p95, `parallel intake ack p95 exceeded budget; ${measured}`).toBeLessThan(ACK_BUDGET_MS);
      expect(lostNames, `parallel intake lost plan names; ${measured}`).toEqual([]);
      expect(doubledNames, `parallel intake duplicated plan names; ${measured}`).toEqual([]);
      expect(nonZeroNames, `parallel intake clients should exit 0; ${measured}`).toEqual([]);
    } finally {
      await cleanup(fixture);
    }
  }, 180_000);
});
