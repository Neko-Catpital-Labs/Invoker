import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const RUN_SH = join(REPO_ROOT, 'run.sh');
const APP_DIST = join(REPO_ROOT, 'packages', 'app', 'dist');
const HEADLESS_CLIENT = join(APP_DIST, 'headless-client.js');
const MAIN_JS = join(APP_DIST, 'main.js');
const INTAKE_COUNT = 50;
const ACK_P95_BUDGET_MS = 200;
const CLIENT_TIMEOUT_MS = 25_000;
const BOOTSTRAP_TIMEOUT_MS = 90_000;
const QUERY_TIMEOUT_MS = 45_000;

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  elapsedMs: number;
  ackMs: number;
};

type IntakeResult = CommandResult & {
  name: string;
  workflowId: string | null;
};

type WorkflowRow = {
  name?: string;
};

type Fixture = {
  tmpDir: string;
  homeDir: string;
  dbDir: string;
  ipcSocket: string;
  configPath: string;
  remoteRepo: string;
  env: NodeJS.ProcessEnv;
};

function runSync(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): void {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(' ')}`,
        `exit=${result.status} signal=${result.signal ?? '<none>'}`,
        `stdout=${result.stdout}`,
        `stderr=${result.stderr}`,
      ].join('\n'),
    );
  }
}

function ensureBuiltApp(): void {
  if (existsSync(HEADLESS_CLIENT) && existsSync(MAIN_JS)) return;
  runSync('pnpm', ['--filter', '@invoker/app', 'build']);
}

function createFixture(): Fixture {
  const tmpDir = mkdtempSync(join(tmpdir(), 'invoker-parallel-storm-'));
  const homeDir = join(tmpDir, 'home');
  const dbDir = join(homeDir, '.invoker');
  const ipcSocket = join(tmpDir, 'ipc-transport.sock');
  const configPath = join(tmpDir, 'config.json');
  const remoteRepo = join(tmpDir, 'remote.git');
  const seedRepo = join(tmpDir, 'seed-repo');

  mkdirSync(dbDir, { recursive: true });
  writeFileSync(configPath, '{"autoFixRetries":0,"maxConcurrency":1}\n', 'utf8');

  runSync('git', ['init', '--bare', remoteRepo]);
  runSync('git', ['init', seedRepo]);
  runSync('git', ['config', 'user.email', 'parallel-storm@example.invalid'], { cwd: seedRepo });
  runSync('git', ['config', 'user.name', 'Parallel Storm Repro'], { cwd: seedRepo });
  writeFileSync(join(seedRepo, 'README.md'), 'parallel storm repro\n', 'utf8');
  runSync('git', ['add', 'README.md'], { cwd: seedRepo });
  runSync('git', ['commit', '-m', 'seed parallel storm repro repository'], { cwd: seedRepo });
  runSync('git', ['branch', '-M', 'main'], { cwd: seedRepo });
  runSync('git', ['remote', 'add', 'origin', remoteRepo], { cwd: seedRepo });
  runSync('git', ['push', 'origin', 'main'], { cwd: seedRepo });

  const env = {
    ...process.env,
    HOME: homeDir,
    INVOKER_DB_DIR: dbDir,
    INVOKER_IPC_SOCKET: ipcSocket,
    INVOKER_REPO_CONFIG_PATH: configPath,
    INVOKER_SKIP_BOOTSTRAP_CHECK: '1',
    NODE_ENV: 'test',
  };
  delete env.INVOKER_DB_PATH;
  delete env.INVOKER_HEADLESS_STANDALONE;
  delete env.INVOKER_HEADLESS_REQUIRE_EXISTING_OWNER;

  return { tmpDir, homeDir, dbDir, ipcSocket, configPath, remoteRepo, env };
}

function spawnCaptured(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number; ackPattern?: RegExp },
): Promise<CommandResult> {
  const startedAt = performance.now();
  const child = spawn(command, args, {
    cwd: REPO_ROOT,
    env: options.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let settled = false;
  let timedOut = false;
  let ackMs: number | null = null;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (ackMs === null && options.ackPattern?.test(stdout)) {
      ackMs = performance.now() - startedAt;
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  return new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
        setTimeout(() => {
          if (!settled && child.pid) {
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {
              child.kill('SIGKILL');
            }
          }
        }, 2_000).unref();
      }
    }, options.timeoutMs);
    timer.unref();

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (exitCode, signal) => {
      settled = true;
      clearTimeout(timer);
      resolveResult({
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut,
        elapsedMs: performance.now() - startedAt,
        ackMs: ackMs ?? performance.now() - startedAt,
      });
    });
  });
}

function writePlan(fixture: Fixture, name: string): string {
  const planPath = join(fixture.tmpDir, `${name}.yaml`);
  writeFileSync(
    planPath,
    [
      `name: ${name}`,
      `repoUrl: ${JSON.stringify(pathToFileURL(fixture.remoteRepo).href)}`,
      'baseBranch: main',
      'onFinish: none',
      'tasks:',
      '  - id: root',
      '    description: approval-gated intake measurement task',
      '    command: echo root',
      '    requiresManualApproval: true',
      '',
    ].join('\n'),
    'utf8',
  );
  return planPath;
}

async function runHeadless(
  fixture: Fixture,
  args: string[],
  timeoutMs: number,
  ackPattern?: RegExp,
): Promise<CommandResult> {
  return spawnCaptured(RUN_SH, ['--headless', ...args], { env: fixture.env, timeoutMs, ackPattern });
}

async function bootstrapOwner(fixture: Fixture): Promise<void> {
  const planPath = writePlan(fixture, 'parallel-storm-bootstrap');
  const result = await runHeadless(
    fixture,
    ['--no-track', 'run', planPath],
    BOOTSTRAP_TIMEOUT_MS,
    /Delegated to owner .*workflow: wf-/,
  );
  const report = `bootstrap exit=${result.exitCode} signal=${result.signal ?? '<none>'} timedOut=${result.timedOut} elapsed=${result.elapsedMs.toFixed(1)}ms stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`;
  expect(result.timedOut, report).toBe(false);
  expect(result.exitCode, report).toBe(0);
  expect(result.stdout, report).toMatch(/Delegated to owner .*workflow: wf-/);
  expect(readOwnerPid(fixture), report).not.toBeNull();
}

function readOwnerPid(fixture: Fixture): number | null {
  const marker = join(fixture.dbDir, 'invoker.db.owner');
  if (!existsSync(marker)) return null;
  const pid = Number.parseInt(readFileSync(marker, 'utf8').trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function findFixturePids(fixture: Fixture): number[] {
  if (process.platform !== 'linux' || !existsSync('/proc')) {
    const pid = readOwnerPid(fixture);
    return pid === null ? [] : [pid];
  }

  const pids: number[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number.parseInt(entry, 10);
    if (pid === process.pid) continue;
    try {
      const env = readFileSync(join('/proc', entry, 'environ'), 'utf8');
      if (env.split('\0').includes(`INVOKER_DB_DIR=${fixture.dbDir}`)) {
        pids.push(pid);
      }
    } catch {
      // Process exited or belongs to another user between /proc scans.
    }
  }
  return pids.sort((left, right) => right - left);
}

async function stopOwner(fixture: Fixture): Promise<void> {
  const pids = findFixturePids(fixture);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      console.warn(`parallel storm cleanup: failed to SIGTERM fixture pid=${pid}: ${String(error)}`);
    }
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (findFixturePids(fixture).length === 0) {
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  for (const pid of findFixturePids(fixture)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      console.warn(`parallel storm cleanup: failed to SIGKILL fixture pid=${pid}: ${String(error)}`);
    }
  }
}

async function submitIntake(fixture: Fixture, index: number): Promise<IntakeResult> {
  const name = `parallel-storm-${index.toString().padStart(2, '0')}`;
  const planPath = writePlan(fixture, name);
  const result = await runHeadless(
    fixture,
    ['--no-track', 'run', planPath],
    CLIENT_TIMEOUT_MS,
    /Delegated to owner .*workflow: wf-/,
  );
  const workflowId = /workflow:\s+(wf-[^\s]+)/.exec(result.stdout)?.[1] ?? null;
  return { ...result, name, workflowId };
}

async function readStoredWorkflows(fixture: Fixture): Promise<WorkflowRow[]> {
  const result = await runHeadless(fixture, ['query', 'workflows', '--output', 'json'], QUERY_TIMEOUT_MS);
  const report = `query workflows exit=${result.exitCode} signal=${result.signal ?? '<none>'} timedOut=${result.timedOut} elapsed=${result.elapsedMs.toFixed(1)}ms stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`;
  expect(result.timedOut, report).toBe(false);
  expect(result.exitCode, report).toBe(0);
  return JSON.parse(result.stdout) as WorkflowRow[];
}

function percentile95(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? 0;
}

function formatNames(names: string[]): string {
  return names.length === 0 ? '<none>' : names.join(', ');
}

describe('parallel headless plan intake storm repro', () => {
  it(
    `stores ${INTAKE_COUNT} parallel one-task intakes once each and acknowledges p95 under ${ACK_P95_BUDGET_MS}ms`,
    async () => {
      ensureBuiltApp();
      const fixture = createFixture();

      try {
        await bootstrapOwner(fixture);

        const intakeResults = await Promise.all(
          Array.from({ length: INTAKE_COUNT }, (_unused, index) => submitIntake(fixture, index + 1)),
        );
        const workflows = await readStoredWorkflows(fixture);
        const countsByName = new Map<string, number>();
        for (const workflow of workflows) {
          if (!workflow.name?.startsWith('parallel-storm-')) continue;
          countsByName.set(workflow.name, (countsByName.get(workflow.name) ?? 0) + 1);
        }

        const names = intakeResults.map((result) => result.name);
        const lostNames = names.filter((name) => (countsByName.get(name) ?? 0) === 0);
        const doubledNames = names.filter((name) => (countsByName.get(name) ?? 0) > 1);
        const timedOutNames = intakeResults
          .filter((result) => result.timedOut || (result.exitCode !== 0 && /timeout|timed out/i.test(result.stderr)))
          .map((result) => result.name);
        const nonZeroNames = intakeResults
          .filter((result) => result.exitCode !== 0)
          .map((result) => `${result.name}:${result.exitCode ?? result.signal ?? 'null'}`);
        const p95 = percentile95(intakeResults.map((result) => result.ackMs));
        const report = [
          `parallel storm measured ack p95=${p95.toFixed(1)}ms`,
          `budget=${ACK_P95_BUDGET_MS}ms`,
          `lost=${formatNames(lostNames)}`,
          `doubled=${formatNames(doubledNames)}`,
          `timedOut=${formatNames(timedOutNames)}`,
          `nonZero=${formatNames(nonZeroNames)}`,
          `workflowIds=${intakeResults.filter((result) => result.workflowId).length}/${INTAKE_COUNT}`,
        ].join('; ');
        console.log(report);

        if (process.env.INVOKER_REPRO_EXPECT === 'bug') {
          const observedDefect =
            p95 > ACK_P95_BUDGET_MS
            || lostNames.length > 0
            || doubledNames.length > 0
            || timedOutNames.length > 0;
          expect(observedDefect, report).toBe(true);
          return;
        }

        expect(p95, report).toBeLessThan(ACK_P95_BUDGET_MS);
        expect(lostNames, report).toEqual([]);
        expect(doubledNames, report).toEqual([]);
        expect(nonZeroNames, report).toEqual([]);
      } finally {
        await stopOwner(fixture);
        rmSync(fixture.tmpDir, { recursive: true, force: true });
      }
    },
    240_000,
  );
});
