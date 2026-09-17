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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(testDir, '../..');
const repoRoot = resolve(packageRoot, '../..');
const cliEntry = join(packageRoot, 'dist/index.js');
const sampleRuns = 10;
const loadRecorderImport = [
  'data:text/javascript,',
  'import{registerHooks}from"node:module";',
  'import{writeFileSync}from"node:fs";',
  'const loaded=[];',
  'registerHooks({load(url,context,nextLoad){loaded.push(url);return nextLoad(url,context);}});',
  'process.on("exit",()=>writeFileSync(process.env.INVOKER_STARTUP_LOAD_LOG,loaded.join("\\n")));',
].join('');

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

function listVersionModuleLoads(): string[] {
  const root = mkdtempSync(join(tmpdir(), 'invoker-cli-module-load-'));
  try {
    const logPath = join(root, 'loads.txt');
    const result = spawnSync(process.execPath, ['--import', loadRecorderImport, cliEntry, '--version'], {
      cwd: packageRoot,
      env: { ...createIsolatedEnv(root), INVOKER_STARTUP_LOAD_LOG: logPath },
      encoding: 'utf8',
      timeout: 20_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0 || !existsSync(logPath)) {
      throw new Error(
        `module-load recording failed: exit=${result.status} stderr=${JSON.stringify(result.stderr)} files=${JSON.stringify(readdirSync(root))}`,
      );
    }
    return readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((url) => url.length > 0 && !url.startsWith('node:'))
      .map((url) => (url.startsWith('file://') ? relative(repoRoot, fileURLToPath(url)) : url));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('repro: invoker client startup latency', () => {
  it('keeps built --version startup free of the command runtime', () => {
    if (!existsSync(cliEntry)) {
      throw new Error(`missing built CLI entry at ${cliEntry}; run pnpm --filter @invoker/cli build`);
    }

    const measured = Array.from({ length: sampleRuns }, () => runVersionOnce().ms);
    const entry = relative(repoRoot, fileURLToPath(pathToFileURL(cliEntry)));
    const loaded = listVersionModuleLoads();
    const extraModules = loaded.filter((moduleName) => moduleName !== entry);
    const expectation = process.env.INVOKER_REPRO_EXPECT === 'bug' ? 'bug' : 'fixed';
    const summary = [
      `invoker-cli --version startup samples=[${measured.map(formatMs).join(', ')}] p50=${formatMs(p50(measured))}`,
      `expectation=${expectation}`,
      `modules loaded besides ${entry}: ${extraModules.length > 0 ? extraModules.join(', ') : 'none'}`,
    ].join('\n');

    process.stdout.write(`${summary}\n`);

    if (expectation === 'bug') {
      if (extraModules.length === 0) {
        throw new Error(`Expected known bug with --version loading the command runtime, but it loaded only the entry.\n${summary}`);
      }
      return;
    }

    if (extraModules.length > 0) {
      throw new Error(`Expected --version to load only the CLI entry, but it loaded more modules.\n${summary}`);
    }
  });
});
