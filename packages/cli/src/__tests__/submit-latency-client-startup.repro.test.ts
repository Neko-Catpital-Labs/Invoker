import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(testDir, '../..');
const repoRoot = resolve(packageRoot, '../..');
const cliEntry = join(packageRoot, 'dist/index.js');
const startupBudgetMs = 80;
const sampleRuns = 10;

type TimedRun = {
  ms: number;
  stdout: string;
};

function createIsolatedEnv(root: string): NodeJS.ProcessEnv {
  const home = join(root, 'home');
  const dbDir = join(root, 'db');
  mkdirSync(home, { recursive: true });
  mkdirSync(dbDir, { recursive: true });
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    INVOKER_DB_DIR: dbDir,
    INVOKER_REPO_CONFIG_PATH: join(root, 'config.json'),
    INVOKER_IPC_SOCKET: join(root, 'owner.sock'),
  };
}

function runVersionOnce(): TimedRun {
  const root = mkdtempSync(join(tmpdir(), 'invoker-cli-startup-'));
  try {
    const start = process.hrtime.bigint();
    const result = spawnSync(process.execPath, [cliEntry, '--version'], {
      cwd: packageRoot,
      env: createIsolatedEnv(root),
      encoding: 'utf8',
      timeout: 15_000,
    });
    const ms = Number(process.hrtime.bigint() - start) / 1_000_000;
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `invoker-cli --version exited ${result.status}; stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
      );
    }
    return { ms, stdout: result.stdout };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function p50(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[Math.floor(mid)]!;
}

function formatMs(value: number): string {
  return `${value.toFixed(1)}ms`;
}

function formatModuleName(moduleName: string): string {
  if (moduleName.startsWith('file://')) {
    return relative(repoRoot, fileURLToPath(moduleName));
  }
  return moduleName;
}

function measureModuleLoads(): string {
  const root = mkdtempSync(join(tmpdir(), 'invoker-cli-module-load-'));
  try {
    const profileName = 'startup.cpuprofile';
    const profilePath = join(root, profileName);
    const result = spawnSync(process.execPath, [
      '--cpu-prof',
      '--cpu-prof-dir',
      root,
      '--cpu-prof-name',
      profileName,
      cliEntry,
      '--version',
    ], {
      cwd: packageRoot,
      env: createIsolatedEnv(root),
      encoding: 'utf8',
      timeout: 20_000,
    });
    if (result.error || result.status !== 0 || !existsSync(profilePath)) {
      return [
        'module-load breakdown unavailable',
        `profile exit=${result.status ?? 'error'}`,
        `stderr=${JSON.stringify(result.stderr)}`,
        `files=${JSON.stringify(readdirSync(root))}`,
      ].join('; ');
    }

    const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as {
      nodes: Array<{ id: number; callFrame: { url?: string } }>;
      samples?: number[];
      timeDeltas?: number[];
    };
    const nodesById = new Map(profile.nodes.map((node) => [node.id, node]));
    const totals = new Map<string, number>();
    for (let index = 0; index < (profile.samples?.length ?? 0); index += 1) {
      const node = nodesById.get(profile.samples![index]!);
      const url = node?.callFrame.url;
      if (!url) continue;
      totals.set(url, (totals.get(url) ?? 0) + ((profile.timeDeltas?.[index] ?? 0) / 1_000));
    }

    const top = [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([moduleName, ms], index) => `${index + 1}. ${formatModuleName(moduleName)} ${formatMs(ms)}`);
    return top.length > 0 ? top.join('; ') : 'module-load breakdown had no load records';
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('repro: invoker client startup latency', () => {
  it('keeps built --version startup within the client budget', () => {
    if (!existsSync(cliEntry)) {
      throw new Error(`missing built CLI entry at ${cliEntry}; run pnpm --filter @invoker/cli build`);
    }

    const runs = Array.from({ length: sampleRuns }, () => runVersionOnce());
    const measured = runs.map((run) => run.ms);
    const medianMs = p50(measured);
    const moduleBreakdown = measureModuleLoads();
    const expectation = process.env.INVOKER_REPRO_EXPECT === 'bug' ? 'bug' : 'fixed';
    const summary = [
      `invoker-cli --version startup samples=[${measured.map(formatMs).join(', ')}]`,
      `p50=${formatMs(medianMs)}`,
      `budget=${formatMs(startupBudgetMs)}`,
      `expectation=${expectation}`,
      `slowest module loads: ${moduleBreakdown}`,
    ].join('\n');

    process.stdout.write(`${summary}\n`);

    if (expectation === 'bug') {
      if (medianMs <= startupBudgetMs) {
        throw new Error(`Expected known bug with p50 over budget, but startup met the budget.\n${summary}`);
      }
      return;
    }

    if (medianMs >= startupBudgetMs) {
      throw new Error(`Expected startup p50 under budget, but measured p50 exceeded it.\n${summary}`);
    }
  });
});
