import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { IpcBus } from '@invoker/transport';

import { createMcpServer, createProcessRunner } from '../mcp-server.js';
import { createDefaultMessageBus, discoverLiveOwner } from '../live-owner-bus.js';

const liveEnabled = process.env.INVOKER_LIVE_MCP === '1';
const repoRoot = resolve(__dirname, '../../../..');
const cliPath = resolve(repoRoot, 'packages/cli/dist/index.js');
const electronLauncher = resolve(repoRoot, 'scripts/electron.cjs');
const appMain = resolve(repoRoot, 'packages/app/dist/main.js');

async function waitForOwner(timeoutMs = 90_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const bus = await createDefaultMessageBus();
    try {
      const owner = await discoverLiveOwner(bus, 2_000);
      if (owner) return;
    } finally {
      bus.disconnect();
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Timed out waiting for isolated owner-serve');
}

describe.runIf(liveEnabled)('live MCP chat-submit handoff', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'invoker-live-mcp-'));
  const socketPath = join(workDir, 'live-ipc.sock');
  const planPath = join(workDir, 'chat-submit-live.yaml');
  let owner: ChildProcess | undefined;

  afterAll(async () => {
    if (owner && !owner.killed) {
      owner.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 1500));
      if (!owner.killed) owner.kill('SIGKILL');
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  it('prepare → one approval → submit live → wait → query', async () => {
    expect(existsSync(cliPath)).toBe(true);
    expect(existsSync(electronLauncher)).toBe(true);
    expect(existsSync(appMain)).toBe(true);

    writeFileSync(planPath, [
      'name: chat-submit-live',
      'description: Live MCP handoff proof for separate-catstack-invoker.',
      'onFinish: none',
      'mergeMode: no_op',
      'scratch: true',
      'tasks:',
      '  - id: prove-live',
      '    description: Print a live-handoff marker.',
      "    command: printf 'LIVE_MCP_HANDOFF_OK\\n'",
      '    dependencies: []',
      '',
    ].join('\n'));

    process.env.INVOKER_DB_DIR = workDir;
    process.env.INVOKER_IPC_SOCKET = socketPath;

    const ownerEnv = {
      ...process.env,
      INVOKER_DB_DIR: workDir,
      INVOKER_IPC_SOCKET: socketPath,
      INVOKER_E2E_HIDE_WINDOW: '1',
      INVOKER_HEADLESS_STANDALONE: '1',
      INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS: '600000',
      INVOKER_UNSAFE_DISABLE_DB_WRITER_LOCK: '1',
      INVOKER_STARTUP_POLL_DELAY_MS: '0',
    };

    const electronArgs = [electronLauncher, appMain, '--headless', 'owner-serve'];
    if (process.platform === 'linux') {
      electronArgs.splice(1, 0, '--no-sandbox');
    }

    owner = spawn(process.execPath, electronArgs, {
      cwd: repoRoot,
      env: ownerEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    owner.stdout?.setEncoding('utf8');
    owner.stderr?.setEncoding('utf8');
    let ownerLog = '';
    owner.stdout?.on('data', (chunk: string) => { ownerLog += chunk; });
    owner.stderr?.on('data', (chunk: string) => { ownerLog += chunk; });
    owner.on('exit', (code, signal) => {
      ownerLog += `\n[owner exited code=${code} signal=${signal}]\n`;
    });

    try {
      await waitForOwner();
    } catch (err) {
      throw new Error(`${err instanceof Error ? err.message : String(err)}\nowner log:\n${ownerLog}`);
    }

    const server = createMcpServer({
      runner: createProcessRunner(cliPath),
      createMessageBus: async () => {
        const bus = new IpcBus(socketPath, { allowServe: false });
        await bus.ready();
        return bus;
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'live-mcp-handoff', version: '0.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const review = await client.callTool({
        name: 'invoker_prepare_plan_review',
        arguments: { planPath },
      });
      expect(review.isError).toBeFalsy();
      const reviewBody = JSON.parse((review.content as Array<{ text: string }>)[0]!.text);
      expect(reviewBody.reviewToken).toMatch(/^rev_/);

      const submit = await client.callTool({
        name: 'invoker_submit_plan',
        arguments: {
          planPath,
          reviewToken: reviewBody.reviewToken,
          mode: 'live',
        },
      });
      expect(submit.isError).toBeFalsy();
      const submitBody = JSON.parse((submit.content as Array<{ text: string }>)[0]!.text);
      expect(submitBody.workflowId).toEqual(expect.any(String));

      const wait = await client.callTool({
        name: 'invoker_wait_for_workflow',
        arguments: {
          workflowId: submitBody.workflowId,
          maxWaitMs: 90_000,
          pollIntervalMs: 500,
        },
      });
      expect(wait.isError).toBeFalsy();
      const waitBody = JSON.parse((wait.content as Array<{ text: string }>)[0]!.text);
      expect(waitBody.settled).toBe(true);
      expect(waitBody.status.failed).toBe(0);
      expect(waitBody.status.completed).toBeGreaterThan(0);

      const tasks = await client.callTool({
        name: 'invoker_list_tasks',
        arguments: { workflowId: submitBody.workflowId },
      });
      expect(tasks.isError).toBeFalsy();
      const tasksBody = JSON.parse((tasks.content as Array<{ text: string }>)[0]!.text);
      expect(tasksBody.tasks.some((task: { id: string; status: string }) => (
        task.id.includes('prove-live') && task.status === 'completed'
      ))).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  }, 180_000);
});
