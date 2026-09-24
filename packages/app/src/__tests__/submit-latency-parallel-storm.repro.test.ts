import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { SQLiteAdapter } from '@invoker/data-store';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const INTAKE_COUNT = 50;
const ACK_BUDGET_MS = 200;
const INTAKE_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 180_000;

type IntakeResult = {
  name: string;
  ackMs: number;
  exitCode: number;
  workflowId?: string;
  stderr: string;
};

function percentile(values: number[], percent: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percent / 100) - 1)] ?? 0;
}

function asFileUrl(path: string): string {
  return `file://${path}`;
}

function writePlan(path: string, name: string, repoUrl: string): void {
  writeFileSync(path, [
    `name: ${name}`,
    `repoUrl: ${repoUrl}`,
    'onFinish: none',
    'baseBranch: main',
    'tasks:',
    '  - id: task',
    '    description: One storm task',
    '    command: echo storm',
    '',
  ].join('\n'));
}

async function submit(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  planPath: string,
  name: string,
): Promise<IntakeResult> {
  const started = performance.now();
  try {
    const result = await execFileAsync(join(repoRoot, 'run.sh'), [
      '--headless', '--no-track', 'run', planPath,
    ], {
      cwd: repoRoot,
      env,
      timeout: INTAKE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    const combined = `${result.stdout}\n${result.stderr}`;
    return {
      name,
      ackMs: performance.now() - started,
      exitCode: 0,
      workflowId: combined.match(/workflow:\s+(wf-\S+)/)?.[1],
      stderr: result.stderr,
    };
  } catch (error) {
    const failure = error as { code?: number | string; killed?: boolean; signal?: string; stdout?: string; stderr?: string; message?: string };
    const stderr = failure.stderr ?? failure.message ?? '';
    const stdout = failure.stdout ?? '';
    return {
      name,
      ackMs: performance.now() - started,
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
      workflowId: `${stdout}\n${stderr}`.match(/workflow:\s+(wf-\S+)/)?.[1],
      stderr,
    };
  }
}

async function stopOwner(dbDir: string): Promise<void> {
  const markerPath = join(dbDir, 'invoker.db.owner');
  if (!existsSync(markerPath)) return;
  const pid = Number(readFileSync(markerPath, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    console.error(`[parallel-storm] owner stop error: ${String(error)}`);
    return;
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    console.error(`[parallel-storm] owner force-stop error: ${String(error)}`);
  }
}

describe('parallel plan intake storm (repro)', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        console.error(`[parallel-storm] temp cleanup error for ${dir}: ${String(error)}`);
      }
    }
  });

  it('stores all 50 unique plans within the explicit ack budget', async () => {
    const repoRoot = join(__dirname, '../../..', '..');
    if (!existsSync(join(repoRoot, 'packages/app/dist/headless-client.js'))) {
      execFileSync('pnpm', ['--filter', '@invoker/app', 'build'], {
        cwd: repoRoot,
        stdio: 'inherit',
        timeout: 120_000,
      });
    }

    const rootDir = mkdtempSync(join(tmpdir(), 'invoker-parallel-storm-'));
    tempDirs.push(rootDir);
    const homeDir = join(rootDir, 'home');
    const dbDir = join(rootDir, 'db');
    const socketPath = join(rootDir, 'ipc-transport.sock');
    const configPath = join(rootDir, 'config.json');
    const bareRepo = join(rootDir, 'remote.git');
    const planDir = join(rootDir, 'plans');
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(dbDir, { recursive: true });
    mkdirSync(planDir, { recursive: true });
    execFileSync('git', ['init', '--bare', bareRepo], { stdio: 'ignore' });
    const env = {
      ...process.env,
      HOME: homeDir,
      INVOKER_DB_DIR: dbDir,
      INVOKER_IPC_SOCKET: socketPath,
      INVOKER_REPO_CONFIG_PATH: configPath,
      INVOKER_SKIP_BOOTSTRAP_CHECK: '1',
    };
    const repoUrl = asFileUrl(bareRepo);
    const bootstrapPath = join(planDir, 'bootstrap.yaml');
    writePlan(bootstrapPath, 'Parallel Storm Bootstrap', repoUrl);

    try {
      const bootstrap = await submit(repoRoot, env, bootstrapPath, 'Parallel Storm Bootstrap');
      if (bootstrap.exitCode !== 0 || !bootstrap.workflowId) {
        throw new Error(
          `parallel storm bootstrap failed: ackMs=${bootstrap.ackMs.toFixed(1)} ` +
          `exitCode=${bootstrap.exitCode} workflowId=${bootstrap.workflowId ?? 'none'} ` +
          `stderr=${JSON.stringify(bootstrap.stderr)}`,
        );
      }
      const names = Array.from({ length: INTAKE_COUNT }, (_, index) => `Parallel Storm ${index}`);
      const results = await Promise.all(names.map((name) => {
        const planPath = join(planDir, `${name.replaceAll(' ', '-').toLowerCase()}.yaml`);
        writePlan(planPath, name, repoUrl);
        return submit(repoRoot, env, planPath, name);
      }));
      await stopOwner(dbDir);

      const adapter = await SQLiteAdapter.create(join(dbDir, 'invoker.db'), { readOnly: true });
      const storedNames = adapter.listWorkflows().map((workflow) => workflow.name);
      adapter.close();
      const counts = new Map(names.map((name) => [name, storedNames.filter((stored) => stored === name).length]));
      const lostOrDoubled = [...counts.entries()]
        .filter(([, count]) => count !== 1)
        .map(([name, count]) => `${name}=${count}`);
      const timedOut = results.filter((result) => result.ackMs >= INTAKE_TIMEOUT_MS || result.stderr.includes('timed out'))
        .map((result) => result.name);
      const p95 = percentile(results.map((result) => result.ackMs), 95);
      const nonZero = results.filter((result) => result.exitCode !== 0).map((result) => `${result.name}=${result.exitCode}`);
      const measured = `p95=${p95.toFixed(1)}ms budget=${ACK_BUDGET_MS}ms timeout=${INTAKE_TIMEOUT_MS}ms lostOrDoubled=${lostOrDoubled.join(',') || 'none'} timedOut=${timedOut.join(',') || 'none'} nonZero=${nonZero.join(',') || 'none'}`;
      console.info(`[parallel-storm] ${measured}`);
      for (const result of results) {
        console.info(`[parallel-storm] ${result.name} ackMs=${result.ackMs.toFixed(1)} exitCode=${result.exitCode} workflowId=${result.workflowId ?? 'none'} stderr=${JSON.stringify(result.stderr)}`);
      }

      const hasDefect = p95 > ACK_BUDGET_MS || lostOrDoubled.length > 0 || timedOut.length > 0 || nonZero.length > 0;
      if (process.env.INVOKER_REPRO_EXPECT === 'bug') {
        expect(hasDefect, measured).toBe(true);
        return;
      }
      expect(p95, measured).toBeLessThan(ACK_BUDGET_MS);
      expect(lostOrDoubled, measured).toEqual([]);
      expect(timedOut, measured).toEqual([]);
      expect(nonZero, measured).toEqual([]);
    } finally {
      await stopOwner(dbDir);
    }
  }, TEST_TIMEOUT_MS);
});
