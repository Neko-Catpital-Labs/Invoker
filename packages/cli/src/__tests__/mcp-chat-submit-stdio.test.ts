import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createDefaultMessageBus, discoverLiveOwner } from '../live-owner-bus.js';

const liveEnabled = process.env.INVOKER_LIVE_MCP === '1';
const repoRoot = resolve(__dirname, '../../../..');
const catstackRoot = resolve(repoRoot, '../catstack');
const cliPath = resolve(repoRoot, 'packages/cli/dist/index.js');
const electronLauncher = resolve(repoRoot, 'scripts/electron.cjs');
const appMain = resolve(repoRoot, 'packages/app/dist/main.js');
const chatSubmitSkill = resolve(repoRoot, 'skills/chat-submit/SKILL.md');
const routingScript = resolve(catstackRoot, 'skills/cat-mode/scripts/route_execution.py');

const CHAT_SUBMIT_TOOLS = [
  'invoker_prepare_plan_review',
  'invoker_submit_plan',
  'invoker_get_workflow',
  'invoker_list_tasks',
  'invoker_wait_for_workflow',
] as const;

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

describe.runIf(liveEnabled)('chat-submit + catstack tie-in (stdio MCP)', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'invoker-chat-submit-'));
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

  it('catstack delegates → chat-submit skill tools over stdio → live complete', async () => {
    expect(existsSync(cliPath)).toBe(true);
    expect(existsSync(chatSubmitSkill)).toBe(true);
    expect(existsSync(routingScript)).toBe(true);

    const skillText = readFileSync(chatSubmitSkill, 'utf8');
    expect(skillText).toContain('invoker_prepare_plan_review');
    expect(skillText).toContain('reviewToken');
    expect(skillText).toContain('One approval');

    // Catstack decision: durable work + Invoker tools present → delegate.
    const routed = spawnSync(
      'python3',
      [routingScript, JSON.stringify({ tools: [...CHAT_SUBMIT_TOOLS], work_kind: 'durable_parallel' })],
      { encoding: 'utf8' },
    );
    expect(routed.status).toBe(0);
    const decision = JSON.parse(routed.stdout) as { route: string; steps: string[] };
    expect(decision.route).toBe('delegate_invoker');
    expect(decision.steps[0]).toBe('invoker_prepare_plan_review');
    expect(decision.steps).toContain('await_one_user_approval');

    writeFileSync(planPath, [
      'name: chat-submit-stdio',
      'description: Stdio MCP chat-submit + catstack routing proof.',
      'onFinish: none',
      'mergeMode: no_op',
      'scratch: true',
      'tasks:',
      '  - id: prove-stdio',
      '    description: Print stdio handoff marker.',
      "    command: printf 'CHAT_SUBMIT_STDIO_OK\\n'",
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
    let ownerLog = '';
    owner.stdout?.setEncoding('utf8');
    owner.stderr?.setEncoding('utf8');
    owner.stdout?.on('data', (chunk: string) => { ownerLog += chunk; });
    owner.stderr?.on('data', (chunk: string) => { ownerLog += chunk; });

    try {
      await waitForOwner();
    } catch (err) {
      throw new Error(`${err instanceof Error ? err.message : String(err)}\nowner log:\n${ownerLog}`);
    }

    // Real stdio MCP process — the same transport Cursor uses for invoker-cli mcp.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, 'mcp'],
      cwd: repoRoot,
      env: {
        INVOKER_DB_DIR: workDir,
        INVOKER_IPC_SOCKET: socketPath,
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'chat-submit-stdio', version: '0.0.0' });
    await client.connect(transport);

    try {
      const tools = await client.listTools();
      const names = new Set(tools.tools.map((tool) => tool.name));
      for (const required of CHAT_SUBMIT_TOOLS) {
        expect(names.has(required)).toBe(true);
      }

      // chat-submit step 2: prepare
      const review = await client.callTool({
        name: 'invoker_prepare_plan_review',
        arguments: { planPath },
      });
      expect(review.isError).toBeFalsy();
      const reviewBody = JSON.parse((review.content as Array<{ text: string }>)[0]!.text);
      expect(reviewBody.reviewToken).toMatch(/^rev_/);
      expect(reviewBody.confirmationMode ?? 'require_approval').not.toBe('auto_submit');

      // chat-submit step 4: reject submit without the one approval token path
      // (token required — missing token must fail before live work starts)
      const denied = await client.callTool({
        name: 'invoker_submit_plan',
        arguments: { planPath, mode: 'live' },
      });
      expect(denied.isError).toBeTruthy();

      // Simulated one explicit user approval → submit with reviewToken
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

      const tasks = await client.callTool({
        name: 'invoker_list_tasks',
        arguments: { workflowId: submitBody.workflowId },
      });
      const tasksBody = JSON.parse((tasks.content as Array<{ text: string }>)[0]!.text);
      expect(tasksBody.tasks.some((task: { id: string; status: string }) => (
        task.id.includes('prove-stdio') && task.status === 'completed'
      ))).toBe(true);
    } finally {
      await client.close();
    }
  }, 180_000);
});
