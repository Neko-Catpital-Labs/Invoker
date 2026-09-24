import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const INTAKE_COUNT = 50;
const ACK_P95_BUDGET_MS = 200;
const CLIENT_TIMEOUT_MS = 20_000;
const OWNER_START_TIMEOUT_MS = 90_000;

const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(testDir, '../..');
const repoRoot = resolve(packageRoot, '../..');
const electronLauncher = join(repoRoot, 'scripts/electron.cjs');
const appMain = join(packageRoot, 'dist/main.js');
const runScript = join(repoRoot, 'run.sh');

type IntakeResult = {
  name: string;
  ackMs: number;
  exitCode: number | null;
  workflowId: string | null;
  stderr: string;
  timedOut: boolean;
};

type Fixture = {
  root: string;
  env: NodeJS.ProcessEnv;
  repoUrl: string;
  owner: ChildProcess;
};

function percentile(values: number[], percent: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percent / 100) - 1)] ?? 0;
}

function seedBareRepo(repoUrl: string): void {
  const seedRepo = `${repoUrl}-seed`;
  execFileSync('git', ['init', '--bare', '--initial-branch=main', repoUrl], { stdio: 'ignore' });
  execFileSync('git', ['init', '--initial-branch=main', seedRepo], { stdio: 'ignore' });
  execFileSync('git', ['-C', seedRepo, 'config', 'user.email', 'repro@example.invalid'], { stdio: 'ignore' });
  execFileSync('git', ['-C', seedRepo, 'config', 'user.name', 'Parallel Storm Repro'], { stdio: 'ignore' });
  writeFileSync(join(seedRepo, 'README.md'), 'parallel storm repro\n');
  execFileSync('git', ['-C', seedRepo, 'add', 'README.md'], { stdio: 'ignore' });
  execFileSync('git', ['-C', seedRepo, 'commit', '-m', 'seed repro repository'], { stdio: 'ignore' });
  execFileSync('git', ['-C', seedRepo, 'remote', 'add', 'origin', repoUrl], { stdio: 'ignore' });
  execFileSync('git', ['-C', seedRepo, 'push', 'origin', 'main'], { stdio: 'ignore' });
}

function writePlan(root: string, repoUrl: string, name: string): string {
  const planPath = join(root, `${name}.yaml`);
  writeFileSync(planPath, [
    `name: ${name}`,
    `repoUrl: ${JSON.stringify(repoUrl)}`,
    'baseBranch: main',
    'onFinish: none',
    'tasks:',
    '  - id: intake',
    '    description: Parallel storm intake',
    '    command: "true"',
    '    requiresManualApproval: true',
    '',
  ].join('\n'));
  return planPath;
}

function extractWorkflowId(stdout: string): string | null {
  return stdout.match(/workflow:\s+(wf-[^\s]+)/)?.[1] ?? null;
}

async function waitForOwner(env: NodeJS.ProcessEnv): Promise<void> {
  const marker = join(env.INVOKER_DB_DIR!, 'invoker.db.owner');
  const deadline = Date.now() + OWNER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(marker)) {
      const pid = Number(readFileSync(marker, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          return;
        } catch {
          // The marker can be visible just before the process is ready.
        }
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error('Timed out waiting for isolated owner-serve');
}

async function stopOwner(owner: ChildProcess): Promise<void> {
  if (owner.exitCode !== null) return;
  await new Promise<void>((resolvePromise) => {
    const finish = () => resolvePromise();
    owner.once('close', finish);
    try {
      owner.kill('SIGTERM');
    } catch (error) {
      console.error(`[submit-latency-parallel-storm] owner SIGTERM failed: ${String(error)}`);
      finish();
      return;
    }
    setTimeout(() => {
      if (owner.exitCode !== null) return;
      try {
        owner.kill('SIGKILL');
      } catch (error) {
        console.error(`[submit-latency-parallel-storm] owner SIGKILL failed: ${String(error)}`);
        finish();
      }
    }, 2_000).unref();
  });
}

function runIntake(planPath: string, name: string, env: NodeJS.ProcessEnv): Promise<IntakeResult> {
  return new Promise((resolvePromise) => {
    const startedAt = performance.now();
    const child = spawn(runScript, ['--headless', '--no-track', 'run', planPath], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, CLIENT_TIMEOUT_MS);
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolvePromise({
        name,
        ackMs: performance.now() - startedAt,
        exitCode,
        workflowId: extractWorkflowId(stdout),
        stderr: stderr.trim(),
        timedOut,
      });
    });
  });
}

async function createFixture(): Promise<Fixture> {
  if (!existsSync(appMain)) {
    execFileSync('pnpm', ['--filter', '@invoker/app', 'build'], { cwd: repoRoot, stdio: 'inherit' });
  }
  const root = mkdtempSync(join(tmpdir(), 'invoker-parallel-storm-repro-'));
  const home = join(root, 'home');
  const dbDir = join(root, 'db');
  const repoUrl = join(root, 'repo.git');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    INVOKER_DB_DIR: dbDir,
    INVOKER_IPC_SOCKET: join(root, 'owner.sock'),
    INVOKER_REPO_CONFIG_PATH: join(root, 'config.json'),
    INVOKER_SKIP_BOOTSTRAP_CHECK: '1',
    INVOKER_E2E_HIDE_WINDOW: '1',
    INVOKER_HEADLESS_STANDALONE: '1',
    INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS: '600000',
    INVOKER_UNSAFE_DISABLE_DB_WRITER_LOCK: '1',
    INVOKER_STARTUP_POLL_DELAY_MS: '0',
  };
  seedBareRepo(repoUrl);
  const args = [electronLauncher, appMain, '--headless', 'owner-serve'];
  if (process.platform === 'linux') args.unshift('--no-sandbox');
  const owner = spawn(process.execPath, args, { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let ownerStderr = '';
  owner.stderr?.setEncoding('utf8');
  owner.stderr?.on('data', (chunk: string) => { ownerStderr += chunk; });
  try {
    await waitForOwner(env);
  } catch (error) {
    await stopOwner(owner);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nowner stderr:\n${ownerStderr}`);
  }
  return { root, env, repoUrl, owner };
}

describe('parallel plan intake storm', () => {
  let fixture: Fixture | undefined;

  afterAll(async () => {
    if (fixture) {
      await stopOwner(fixture.owner);
      try {
        rmSync(fixture.root, { recursive: true, force: true });
      } catch (error) {
        console.error(`[submit-latency-parallel-storm] temp cleanup failed: ${String(error)}`);
      }
      fixture = undefined;
    }
  });

  it('stores all 50 concurrent one-task plan intakes within the ack budget', async () => {
    fixture = await createFixture();
    const names = Array.from({ length: INTAKE_COUNT }, (_, index) => `parallel-storm-${index}`);
    const plans = names.map((name) => writePlan(fixture!.root, fixture!.repoUrl, name));
    const results = await Promise.all(plans.map((planPath, index) => runIntake(planPath, names[index]!, fixture!.env)));
    const query = await new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolvePromise) => {
      const child = spawn(runScript, ['--headless', 'query', 'workflows', '--output', 'json'], {
        cwd: repoRoot,
        env: { ...fixture!.env, INVOKER_HEADLESS_REQUIRE_EXISTING_OWNER: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.on('close', (exitCode) => resolvePromise({ exitCode, stdout, stderr }));
    });
    if (query.exitCode !== 0) throw new Error(`workflow query failed: exit=${query.exitCode} stderr=${query.stderr}`);
    const storedWorkflows = JSON.parse(query.stdout) as Array<{ name: string }>;
    const counts = new Map(names.map((name) => [name, 0]));
    for (const workflow of storedWorkflows) {
      if (counts.has(workflow.name)) counts.set(workflow.name, counts.get(workflow.name)! + 1);
    }
    const lostNames = names.filter((name) => counts.get(name) === 0);
    const doubledNames = names.filter((name) => (counts.get(name) ?? 0) > 1);
    const p95Ms = percentile(results.map((result) => result.ackMs), 95);
    const timedOut = results.filter((result) => result.timedOut).map((result) => result.name);
    const failed = results.filter((result) => result.exitCode !== 0).map((result) => `${result.name}:${result.exitCode}`);
    const details = [
      `ackP95=${p95Ms.toFixed(1)}ms`,
      `budget=${ACK_P95_BUDGET_MS}ms`,
      `lostNames=${lostNames.join(',') || 'none'}`,
      `doubledNames=${doubledNames.join(',') || 'none'}`,
      `storedWorkflowNames=${storedWorkflows.map((workflow) => workflow.name).join(',') || 'none'}`,
      `timedOut=${timedOut.join(',') || 'none'}`,
      `failed=${failed.join(',') || 'none'}`,
      `intakes=${results.map((result) => `${result.name}{ackMs=${result.ackMs.toFixed(1)},exit=${result.exitCode},workflowId=${result.workflowId ?? 'none'},stderr=${JSON.stringify(result.stderr)}}`).join(' ')}]`,
    ].join(' ');
    console.error(`[submit-latency-parallel-storm] ${details}`);

    if (process.env.INVOKER_REPRO_EXPECT === 'bug') {
      expect(p95Ms > ACK_P95_BUDGET_MS || lostNames.length > 0 || doubledNames.length > 0 || timedOut.length > 0, details).toBe(true);
      return;
    }
    expect(p95Ms, details).toBeLessThan(ACK_P95_BUDGET_MS);
    expect(lostNames, details).toEqual([]);
    expect(doubledNames, details).toEqual([]);
    expect(timedOut, details).toEqual([]);
    expect(results.every((result) => result.exitCode === 0), details).toBe(true);
  }, 180_000);
});
