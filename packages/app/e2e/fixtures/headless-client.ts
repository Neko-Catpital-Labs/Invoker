import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { writeFile } from 'node:fs/promises';
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
