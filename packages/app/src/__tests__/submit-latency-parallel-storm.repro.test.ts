import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const INTAKE_COUNT = 50;
const ACK_BUDGET_MS = 200;
const INTAKE_TIMEOUT_MS = 25_000;
const OWNER_STOP_WAIT_MS = 5_000;
const repoRoot = resolve(__dirname, '../../../..');

type IntakeResult = {
  name: string;
  ackMs: number;
  exitCode: number | null;
  workflowId: string | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
};

type TestFixture = {
  tmpDir: string;
  homeDir: string;
  dbDir: string;
  ipcSocket: string;
  configPath: string;
  remoteRepo: string;
  blockerWorkflowId: string;
  env: NodeJS.ProcessEnv;
};

function percentile95(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? 0;
}

function formatMs(value: number): string {
  return value.toFixed(1);
}

function extractWorkflowId(stdout: string): string | null {
  return stdout.match(/workflow:\s*(wf-[^\s]+)/)?.[1]
    ?? stdout.match(/Workflow ID:\s*(wf-[^\s]+)/)?.[1]
    ?? null;
}

function resultTimedOut(result: IntakeResult): boolean {
  return result.timedOut || /timed?\s*out|timeout/i.test(`${result.stdout}\n${result.stderr}`);
}

async function runInvoker(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<Omit<IntakeResult, 'name' | 'workflowId'>> {
  const startedAt = performance.now();
  return await new Promise((resolve) => {
    const child = spawn('./run.sh', ['--headless', ...args], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let exited = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!exited) child.kill('SIGKILL');
      }, 1_000).unref();
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => {
      exited = true;
      clearTimeout(timer);
      resolve({
        ackMs: performance.now() - startedAt,
        exitCode: 1,
        stdout,
        stderr: `${stderr}\n${error instanceof Error ? error.stack ?? error.message : String(error)}`,
        timedOut,
      });
    });
    child.once('exit', (exitCode) => {
      exited = true;
      clearTimeout(timer);
      resolve({
        ackMs: performance.now() - startedAt,
        exitCode,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

function runChecked(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error([
      `command failed: ${command} ${args.join(' ')}`,
      `exit=${result.status} signal=${result.signal ?? ''}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  return result.stdout;
}

function ensureBuiltApp(): void {
  if (existsSync(join(repoRoot, 'packages/app/dist/headless-client.js'))
    && existsSync(join(repoRoot, 'packages/app/dist/main.js'))) {
    return;
  }
  runChecked('pnpm', ['--filter', '@invoker/app', 'build']);
}

function createBareRepo(tmpDir: string): string {
  const remoteRepo = join(tmpDir, 'remote.git');
  const seedRepo = join(tmpDir, 'seed-repo');
  runChecked('git', ['init', '--bare', remoteRepo]);
  runChecked('git', ['init', seedRepo]);
  runChecked('git', ['-C', seedRepo, 'config', 'user.email', 'parallel-storm@example.invalid']);
  runChecked('git', ['-C', seedRepo, 'config', 'user.name', 'Parallel Storm Repro']);
  writeFileSync(join(seedRepo, 'README.md'), 'parallel storm repro repository\n');
  runChecked('git', ['-C', seedRepo, 'add', 'README.md']);
  runChecked('git', ['-C', seedRepo, 'commit', '-m', 'seed parallel storm repository']);
  runChecked('git', ['-C', seedRepo, 'branch', '-M', 'main']);
  runChecked('git', ['-C', seedRepo, 'remote', 'add', 'origin', remoteRepo]);
  runChecked('git', ['-C', seedRepo, 'push', 'origin', 'main']);
  return remoteRepo;
}

function writePlan(path: string, name: string, repoUrl: string, blockerWorkflowId?: string): void {
  writeFileSync(path, [
    `name: ${name}`,
    `repoUrl: ${repoUrl}`,
    'onFinish: none',
    'baseBranch: main',
    ...(blockerWorkflowId ? [
      'externalDependencies:',
      `  - workflowId: ${blockerWorkflowId}`,
      '    taskId: root',
      '    gatePolicy: completed',
    ] : []),
    'tasks:',
    '  - id: root',
    `    description: ${name}`,
    '    command: "true"',
    ...(!blockerWorkflowId ? ['    requiresManualApproval: true'] : []),
    '',
  ].join('\n'));
}

async function createFixture(): Promise<TestFixture> {
  ensureBuiltApp();
  const tmpDir = mkdtempSync(join(tmpdir(), 'invoker-parallel-storm-'));
  const homeDir = join(tmpDir, 'home');
  const dbDir = join(homeDir, '.invoker');
  const ipcSocket = join(tmpDir, 'ipc-transport.sock');
  const configPath = join(tmpDir, 'config.json');
  const remoteRepo = createBareRepo(tmpDir);
  writeFileSync(configPath, '{"autoFixRetries":0,"maxConcurrency":1}\n');
  const env = {
    ...process.env,
    HOME: homeDir,
    INVOKER_DB_DIR: dbDir,
    INVOKER_IPC_SOCKET: ipcSocket,
    INVOKER_REPO_CONFIG_PATH: configPath,
    INVOKER_SKIP_BOOTSTRAP_CHECK: '1',
    INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS: '600000',
  };
  const blockerPlan = join(tmpDir, 'blocker-plan.yaml');
  writePlan(blockerPlan, 'Parallel Storm Blocker', pathToFileURL(remoteRepo).href);
  const bootstrap = await runInvoker(['--no-track', 'run', blockerPlan], env, 60_000);
  const blockerWorkflowId = extractWorkflowId(bootstrap.stdout);
  if (bootstrap.exitCode !== 0 || !blockerWorkflowId) {
    throw new Error([
      'failed to bootstrap throwaway owner',
      `exit=${bootstrap.exitCode} elapsed=${formatMs(bootstrap.ackMs)}ms`,
      bootstrap.stdout,
      bootstrap.stderr,
    ].join('\n'));
  }
  return { tmpDir, homeDir, dbDir, ipcSocket, configPath, remoteRepo, blockerWorkflowId, env };
}

function ownerPidFromMarker(dbDir: string): number | null {
  try {
    const raw = readFileSync(join(dbDir, 'invoker.db.owner'), 'utf8').trim();
    return /^[1-9][0-9]*$/.test(raw) ? Number(raw) : null;
  } catch {
    return null;
  }
}

function processCommand(pid: number): string {
  const result = spawnSync('ps', ['-p', String(pid), '-ww', '-o', 'command='], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout : '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopOwner(dbDir: string): Promise<void> {
  const pid = ownerPidFromMarker(dbDir);
  if (!pid) return;
  const command = processCommand(pid);
  if (!command.includes('packages/app/dist/main.js') || !command.includes('owner-serve')) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + OWNER_STOP_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await sleep(100);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // The owner may have exited between the liveness check and SIGKILL.
  }
}

async function submitIntake(fixture: TestFixture, index: number): Promise<IntakeResult> {
  const name = `Parallel Storm Intake ${String(index).padStart(2, '0')}`;
  const planPath = join(fixture.tmpDir, `parallel-storm-${index}.yaml`);
  writePlan(planPath, name, pathToFileURL(fixture.remoteRepo).href, fixture.blockerWorkflowId);
  const result = await runInvoker(['--no-track', 'run', planPath], fixture.env, INTAKE_TIMEOUT_MS);
  return {
    name,
    workflowId: extractWorkflowId(result.stdout),
    ...result,
  };
}

async function listWorkflowNames(fixture: TestFixture): Promise<string[]> {
  const result = await runInvoker(['query', 'workflows', '--output', 'json'], fixture.env, 30_000);
  if (result.exitCode !== 0) {
    throw new Error([
      'failed to query workflows from throwaway owner database',
      `exit=${result.exitCode}`,
      result.stdout,
      result.stderr,
    ].join('\n'));
  }
  const parsed = JSON.parse(result.stdout) as Array<{ name?: unknown }>;
  return parsed.map((workflow) => String(workflow.name ?? ''));
}

function formatReport(results: IntakeResult[], counts: Map<string, number>): string {
  const p95 = percentile95(results.map((result) => result.ackMs));
  const lost = results.map((result) => result.name).filter((name) => (counts.get(name) ?? 0) === 0);
  const doubled = results.map((result) => result.name).filter((name) => (counts.get(name) ?? 0) > 1);
  const timedOut = results.filter(resultTimedOut).map((result) => result.name);
  const badExits = results.filter((result) => result.exitCode !== 0).map((result) => `${result.name}:${result.exitCode}`);
  const workflowIds = results
    .filter((result) => result.workflowId)
    .map((result) => `${result.name}=${result.workflowId}`)
    .join(', ');
  return [
    `p95=${formatMs(p95)}ms`,
    `budget=${ACK_BUDGET_MS}ms`,
    `lost=[${lost.join(', ')}]`,
    `doubled=[${doubled.join(', ')}]`,
    `timedOut=[${timedOut.join(', ')}]`,
    `badExits=[${badExits.join(', ')}]`,
    `workflowIds=[${workflowIds}]`,
  ].join(' ');
}

describe('parallel plan intake storm', () => {
  it(
    `stores ${INTAKE_COUNT} simultaneous plan intakes exactly once with p95 ack under ${ACK_BUDGET_MS}ms`,
    async () => {
      const fixture = await createFixture();
      try {
        const results = await Promise.all(
          Array.from({ length: INTAKE_COUNT }, (_, index) => submitIntake(fixture, index + 1)),
        );
        const names = await listWorkflowNames(fixture);
        const counts = new Map<string, number>();
        for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);

        const p95 = percentile95(results.map((result) => result.ackMs));
        const lost = results.map((result) => result.name).filter((name) => (counts.get(name) ?? 0) === 0);
        const doubled = results.map((result) => result.name).filter((name) => (counts.get(name) ?? 0) > 1);
        const timedOut = results.filter(resultTimedOut);
        const report = formatReport(results, counts);
        console.error(`[submit-latency-parallel-storm] ${report}`);

        if (process.env.INVOKER_REPRO_EXPECT === 'bug') {
          expect(
            p95 > ACK_BUDGET_MS || lost.length > 0 || doubled.length > 0 || timedOut.length > 0,
            `expected current bug to exceed the budget, lose/double a stored plan, or time out: ${report}`,
          ).toBe(true);
          return;
        }

        expect(p95, `ack p95 exceeded budget: ${report}`).toBeLessThan(ACK_BUDGET_MS);
        expect(lost, `some plan names were not stored exactly once: ${report}`).toEqual([]);
        expect(doubled, `some plan names were stored more than once: ${report}`).toEqual([]);
        expect(timedOut.map((result) => result.name), `some intakes timed out: ${report}`).toEqual([]);
        expect(
          results.filter((result) => result.exitCode !== 0).map((result) => `${result.name}:${result.exitCode}\n${result.stderr}`),
          `some intakes exited non-zero: ${report}`,
        ).toEqual([]);
      } finally {
        try {
          await stopOwner(fixture.dbDir);
        } catch (error) {
          console.error(`[submit-latency-parallel-storm] owner cleanup failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        }
        rmSync(fixture.tmpDir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
