import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { resolveRepoRoot } from '@invoker/contracts';

const execFileAsync = promisify(execFile);
const repoRoot = resolveRepoRoot(__dirname);

export async function ensureHeadlessTestConfig(testDir: string): Promise<void> {
  await writeFile(path.join(testDir, 'e2e-config.json'), JSON.stringify({ autoFixRetries: 0 }), 'utf8');
}

export function headlessTestEnv(testDir: string): NodeJS.ProcessEnv {
  const configPath = path.join(testDir, 'e2e-config.json');
  const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
  return {
    ...process.env,
    NODE_ENV: 'test',
    INVOKER_TEST_WORKFLOW_IDS: '1',
    TZ: 'UTC',
    INVOKER_DB_DIR: testDir,
    INVOKER_IPC_SOCKET: ipcSocketPath,
    INVOKER_REPO_CONFIG_PATH: configPath,
  };
}

export async function runHeadlessClient(testDir: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  await ensureHeadlessTestConfig(testDir);
  const clientPath = path.join(repoRoot, 'packages', 'app', 'dist', 'headless-client.js');
  return await execFileAsync('node', [clientPath, ...args], {
    cwd: repoRoot,
    env: headlessTestEnv(testDir),
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function readProcFile(pid: string, name: 'cmdline' | 'environ'): Promise<Buffer | null> {
  try {
    return await readFile(path.join('/proc', pid, name));
  } catch {
    return null;
  }
}

function procFields(buffer: Buffer | null): string[] {
  return buffer?.toString('utf8').split('\0').filter(Boolean) ?? [];
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !processIsRunning(pid);
}

async function headlessOwnerPidsForTestDir(testDir: string): Promise<number[]> {
  if (process.platform !== 'linux') return [];
  const entries = await readdir('/proc', { withFileTypes: true });
  const pids: number[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const [cmdline, environ] = await Promise.all([
      readProcFile(entry.name, 'cmdline'),
      readProcFile(entry.name, 'environ'),
    ]);
    const args = procFields(cmdline);
    if (!args.includes('--headless') || !args.includes('owner-serve')) continue;
    if (!procFields(environ).includes(`INVOKER_DB_DIR=${testDir}`)) continue;
    pids.push(Number(entry.name));
  }
  return [...new Set(pids)].sort((a, b) => b - a);
}

export async function terminateHeadlessOwnersForTestDir(testDir: string): Promise<void> {
  const pids = await headlessOwnerPidsForTestDir(testDir);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
  const stillRunning: number[] = [];
  for (const pid of pids) {
    if (!await waitForExit(pid, 2_000)) {
      stillRunning.push(pid);
    }
  }
  for (const pid of stillRunning) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

export function parseWorkflowId(stdout: string): string {
  const delegated = stdout.match(/Delegated to owner — workflow: (wf-[^\s]+)/);
  if (delegated?.[1]) return delegated[1];
  const direct = stdout.match(/Workflow ID: (wf-[^\s]+)/);
  if (direct?.[1]) return direct[1];
  throw new Error(`No workflow id found in stdout:\n${stdout}`);
}

export function expectDelegated(stdout: string): void {
  if (!stdout.includes('Delegated to owner')) {
    throw new Error(`Expected headless command to delegate to owner, got stdout:\n${stdout}`);
  }
}

export function parseJsonStdout(stdout: string): Record<string, unknown> {
  const line = stdout.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.startsWith('{'));
  if (!line) throw new Error(`No JSON object found in stdout:\n${stdout}`);
  return JSON.parse(line) as Record<string, unknown>;
}
