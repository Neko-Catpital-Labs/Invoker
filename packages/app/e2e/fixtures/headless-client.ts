import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { resolveRepoRoot } from '@invoker/contracts';
import { resolveOwnerChildProfileEnv } from '../../src/headless-owner-bootstrap.js';

const execFileAsync = promisify(execFile);
const repoRoot = resolveRepoRoot(__dirname);

export function e2eDevelopmentProfileEnv(
  testDir: string,
  electronUserDataDir: string,
  configPath: string,
  ipcSocketPath: string,
): Record<string, string> {
  return resolveOwnerChildProfileEnv({
    INVOKER_RUNTIME_KIND: 'source-development',
    INVOKER_DEVELOPMENT_PROFILE: '1',
    INVOKER_DEVELOPMENT_PROFILE_ACTIVE: '1',
    INVOKER_SOURCE_ROOT: repoRoot,
    INVOKER_PROFILE_ID: path.basename(testDir),
    INVOKER_DB_DIR: testDir,
    INVOKER_USER_DATA_DIR: electronUserDataDir,
    INVOKER_IPC_SOCKET: ipcSocketPath,
    INVOKER_REPO_CONFIG_PATH: configPath,
    INVOKER_ENV_PATH: path.join(testDir, '.env'),
    INVOKER_LOG_PATH: path.join(testDir, 'invoker.log'),
    INVOKER_API_PORT: '0',
    INVOKER_WEB_PORT: '0',
  });
}

type StandaloneOwnerProcess = {
  pid: number;
  cmdline: string;
  envMarker: string;
};

export async function ensureHeadlessTestConfig(testDir: string): Promise<void> {
  await writeFile(path.join(testDir, 'e2e-config.json'), JSON.stringify({ autoFixRetries: 0 }), 'utf8');
}

export function headlessTestEnv(testDir: string): NodeJS.ProcessEnv {
  const configPath = path.join(testDir, 'e2e-config.json');
  const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
  return {
    ...process.env,
    ...e2eDevelopmentProfileEnv(
      testDir,
      path.join(testDir, 'headless-electron-user-data'),
      configPath,
      ipcSocketPath,
    ),
    NODE_ENV: 'test',
    INVOKER_TEST_WORKFLOW_IDS: '1',
    TZ: 'UTC',
    INVOKER_DB_DIR: testDir,
    INVOKER_IPC_SOCKET: ipcSocketPath,
    INVOKER_REPO_CONFIG_PATH: configPath,
    INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS:
      process.env.INVOKER_E2E_STANDALONE_OWNER_IDLE_TIMEOUT_MS ?? '5000',
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

async function readStandaloneOwnerProcess(pid: number, testDir: string, ipcSocketPath: string): Promise<StandaloneOwnerProcess | null> {
  let cmdline: string;
  let environ: string;
  try {
    cmdline = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).replace(/\0/g, ' ');
    if (
      !cmdline.includes('packages/app/dist/main.js') ||
      !cmdline.includes('--headless') ||
      !cmdline.includes('owner-serve')
    ) {
      return null;
    }
    environ = await readFile(`/proc/${pid}/environ`, 'utf8');
  } catch {
    return null;
  }

  const dbMarker = `INVOKER_DB_DIR=${testDir}\0`;
  if (environ.includes(dbMarker)) {
    return { pid, cmdline, envMarker: dbMarker };
  }

  const ipcMarker = `INVOKER_IPC_SOCKET=${ipcSocketPath}\0`;
  if (environ.includes(ipcMarker)) {
    return { pid, cmdline, envMarker: ipcMarker };
  }

  return null;
}

export async function cleanupStandaloneOwnersForTestDir(testDir: string): Promise<void> {
  if (process.platform !== 'linux') return;

  const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
  const owners = new Map<number, StandaloneOwnerProcess>();
  let procEntries: string[];
  try {
    procEntries = await readdir('/proc');
  } catch {
    return;
  }

  for (const entry of procEntries) {
    if (!/^\d+$/.test(entry)) continue;

    const pid = Number(entry);
    const owner = await readStandaloneOwnerProcess(pid, testDir, ipcSocketPath);
    if (owner) owners.set(pid, owner);
  }

  for (const pid of owners.keys()) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process already exited.
    }
  }

  if (owners.size === 0) return;

  await delay(1000);

  for (const [pid, owner] of owners) {
    const currentOwner = await readStandaloneOwnerProcess(pid, testDir, ipcSocketPath);
    if (!currentOwner || currentOwner.cmdline !== owner.cmdline || currentOwner.envMarker !== owner.envMarker) {
      continue;
    }

    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
    } catch {
      // Process already exited.
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
