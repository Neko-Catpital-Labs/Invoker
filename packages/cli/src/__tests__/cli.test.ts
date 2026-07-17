import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LocalBus } from '@invoker/transport';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../index.js';
import { HANDOFF_PROMPT_DESCRIPTION, handoffPrompt, resolveCliInvocation, submitPlanForMcp, validatePlanForMcp, type McpCliRunner } from '../mcp-server.js';

const repoRoot = resolve(__dirname, '../../../..');
const cliPath = resolve(repoRoot, 'packages/cli/dist/index.js');
const fixturePlan = resolve(repoRoot, 'plans/fixtures/hello-world.yaml');

function writeStandalonePlan(dir: string, body: string): string {
  const planPath = join(dir, 'plan.yaml');
  writeFileSync(planPath, body.replace('__REPO_ROOT__', JSON.stringify(repoRoot)), 'utf8');
  return planPath;
}

function runCli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', rejectRun);
    child.once('close', (status) => {
      resolveRun({ status, stdout, stderr });
    });
  });
}

function captureProcessOutput() {
  let stdout = '';
  let stderr = '';
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    stdout += chunk.toString();
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
    stderr += chunk.toString();
    return true;
  });
  return {
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    restore() {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    },
  };
}
function makeSpawnProcessStub() {
  return vi.fn(() => {
    const child = new EventEmitter() as ReturnType<typeof spawn>;
    process.nextTick(() => {
      child.emit('exit', 0, null);
    });
    return child;
  });
}

describe('invoker-cli', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('declares MCP runtime dependencies in the CLI manifest and lockfile', () => {
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'packages/cli/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const lockfile = readFileSync(resolve(repoRoot, 'pnpm-lock.yaml'), 'utf8');

    expect(manifest.dependencies?.['@modelcontextprotocol/sdk']).toBe('^1.29.0');
    expect(manifest.dependencies?.zod).toBe('^4.4.3');
    expect(lockfile).toContain('  packages/cli:\n');
    expect(lockfile).toContain("      '@modelcontextprotocol/sdk':\n        specifier: ^1.29.0\n");
    expect(lockfile).toContain('      zod:\n        specifier: ^4.4.3\n');
    expect(lockfile).toContain("'@modelcontextprotocol/sdk@1.29.0(zod@4.4.3)':");
    expect(lockfile).toContain('  zod@4.4.3:');
  });

  it('--help exits 0', async () => {
    const result = await runCli(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('invoker-cli run <plan.yaml>');
  });

  it('--help lists the MCP server command and JSON-only output contract', async () => {
    const result = await runCli(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('invoker-cli mcp');
    expect(result.stdout).toContain('Emit only a machine-readable result summary on stdout.');
  });

  it('--help lists the planner setup command', async () => {
    const result = await runCli(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('invoker-cli setup [planner|slack]');
    expect(result.stdout).toContain('--planner-url <url>');
    expect(result.stdout).toContain('Defaults to ~/.invoker/mcp.json');
  });

  it('lists worker kinds from the registry', async () => {
    const output = captureProcessOutput();

    const code = await main(['worker', 'list'], {
      createMessageBus: () => {
        throw new Error('worker list should not open IPC');
      },
    });

    expect(code).toBe(0);
    expect(output.stdout).toContain('Worker kinds');
    expect(output.stdout).toContain('autofix');
    output.restore();
  });

  it('rejects unknown worker kinds with a clear non-zero error', async () => {
    const output = captureProcessOutput();

    const code = await main(['worker', 'missing-kind']);

    expect(code).toBe(1);
    expect(output.stderr).toContain('Unknown worker kind: "missing-kind"');
    output.restore();
  });

  it('mcp command starts the MCP server runner', async () => {
    const runMcpServer = vi.fn(async () => {});

    const code = await main(['mcp'], { runMcpServer });

    expect(code).toBe(0);
    expect(runMcpServer).toHaveBeenCalledTimes(1);
  });
  it('--help lists the headless owner command', async () => {
    const result = await runCli(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('invoker-cli owner serve');
    expect(result.stdout).toContain('Start a headless Invoker owner process.');
  });

  it('owner serve launches the resolved headless owner command', async () => {
    const spawnProcess = makeSpawnProcessStub();

    const code = await main(['owner', 'serve'], {
      resolveOwnerLaunchSpec: () => ({
        command: '/usr/local/bin/invoker-ui',
        args: ['--headless', 'owner-serve'],
      }),
      spawnProcess,
    });

    expect(code).toBe(0);
    expect(spawnProcess).toHaveBeenCalledWith(
      '/usr/local/bin/invoker-ui',
      ['--headless', 'owner-serve'],
      expect.objectContaining({
        stdio: 'inherit',
      }),
    );
  });

  it('runs the hello-world fixture with an isolated db dir', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'invoker-cli-test-db-'));
    const result = await runCli(['run', fixturePlan, '--standalone', '--db-dir', dbDir]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('hello-from-invoker-cli');
  });

  it('--json emits only a workflow result object on stdout', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'invoker-cli-json-db-'));
    const result = await runCli(['run', fixturePlan, '--standalone', '--db-dir', dbDir, '--json']);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.workflow.status).toBe('success');
    expect(result.stdout).not.toContain('hello-from-invoker-cli');
    expect(result.stderr).toBe('');
  });

  it('invalid YAML exits non-zero with a validation error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'invoker-cli-invalid-'));
    const invalidPlan = join(dir, 'invalid.yaml');
    writeFileSync(invalidPlan, 'name: [broken\n', 'utf8');
    const result = await runCli(['run', invalidPlan, '--standalone', '--db-dir', join(dir, 'db')]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Invalid YAML');
  });

  it('--live delegates run to a reachable GUI owner', async () => {
    const output = captureProcessOutput();
    const bus = new LocalBus();
    const runHandler = vi.fn(async (req: unknown) => {
      expect(req).toEqual(expect.objectContaining({
        planPath: fixturePlan,
        traceId: expect.stringContaining('invoker-cli.headless.run'),
      }));
      return { workflowId: 'wf-live-1', tasks: [] };
    });
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'gui-1', mode: 'gui' }));
    bus.onRequest('headless.run', runHandler);

    const code = await main(['run', fixturePlan, '--live'], { createMessageBus: () => bus });

    expect(code).toBe(0);
    expect(runHandler).toHaveBeenCalledTimes(1);
    expect(output.stdout).toContain('Delegated to live owner - workflow: wf-live-1');
    output.restore();
  });

  it('--live exits non-zero when no GUI owner is reachable', async () => {
    const output = captureProcessOutput();
    const bus = new LocalBus();

    const code = await main(['run', fixturePlan, '--live'], { createMessageBus: () => bus });

    expect(code).toBe(1);
    expect(output.stderr).toContain('No running Invoker UI owner is reachable');
    output.restore();
  });

  it('--standalone never opens IPC and still runs hello-world', async () => {
    const output = captureProcessOutput();
    const dir = mkdtempSync(join(tmpdir(), 'invoker-cli-standalone-'));
    const dbDir = join(dir, 'db');
    const planPath = writeStandalonePlan(dir, `name: Standalone in process
repoUrl: __REPO_ROOT__
onFinish: none
tasks:
  - id: hello
    description: Print hello from the standalone CLI.
    command: echo hello-from-invoker-cli
`);
    const createMessageBus = vi.fn(() => {
      throw new Error('unexpected IPC');
    });

    const code = await main(
      ['run', planPath, '--standalone', '--db-dir', dbDir],
      { createMessageBus },
    );

    expect(code).toBe(0);
    expect(createMessageBus).not.toHaveBeenCalled();
    expect(output.stdout).toContain('hello-from-invoker-cli');
    output.restore();
  });

  it('auto mode delegates when a GUI owner exists', async () => {
    const output = captureProcessOutput();
    const bus = new LocalBus();
    const runHandler = vi.fn(async () => ({ workflowId: 'wf-auto-live', tasks: [] }));
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'gui-1', mode: 'gui' }));
    bus.onRequest('headless.run', runHandler);

    const code = await main(['run', fixturePlan], { createMessageBus: () => bus });

    expect(code).toBe(0);
    expect(runHandler).toHaveBeenCalledTimes(1);
    expect(output.stdout).toContain('wf-auto-live');
    output.restore();
  });

  it('auto mode falls back to standalone when no GUI owner exists', async () => {
    const output = captureProcessOutput();
    const bus = new LocalBus();
    const dir = mkdtempSync(join(tmpdir(), 'invoker-cli-auto-'));
    const dbDir = join(dir, 'db');
    const planPath = writeStandalonePlan(dir, `name: Auto fallback in process
repoUrl: __REPO_ROOT__
onFinish: none
tasks:
  - id: hello
    description: Print hello from the standalone CLI.
    command: echo hello-from-invoker-cli
`);

    const code = await main(
      ['run', planPath, '--db-dir', dbDir],
      { createMessageBus: () => bus },
    );

    expect(code).toBe(0);
    expect(output.stdout).toContain('hello-from-invoker-cli');
    expect(output.stderr).toContain('Live owner discovery has no handler; falling back to standalone mode');
    output.restore();
  }, 60_000);

  it('standalone prompt-only plans route through the execution engine', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'invoker-cli-prompt-'));
    const planPath = writeStandalonePlan(dir, `name: Prompt-only standalone
repoUrl: __REPO_ROOT__
onFinish: none
tasks:
  - id: prompt
    description: Exercise prompt-only execution.
    prompt: Say hello.
    executionAgent: missing-agent
`);

    const result = await runCli(['run', planPath, '--standalone', '--db-dir', join(dir, 'db'), '--json']);

    expect(result.status).not.toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.workflow.status).toBe('failed');
    expect(json.result.failedTasks).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('Standalone CLI v1 supports command tasks only');
  });



  it('tells MCP handoff users to trigger PR skills before publication work', () => {
    const prompt = handoffPrompt('publish this as a PR stack');

    expect(prompt).toContain('creating, updating, publishing, or splitting pull requests or PR stacks');
    expect(prompt).toContain('skill://make-pr/SKILL.md');
    expect(prompt).toContain('before PR authoring or publication');
    expect(prompt).toContain('multiple review slices');
    expect(prompt).toContain('skill://review-compression/SKILL.md');
    expect(prompt).toContain('before writing workflow YAML');
  });

  it('describes PR skill triggers in the MCP prompt metadata', () => {
    expect(HANDOFF_PROMPT_DESCRIPTION).toContain('trigger PR skills for PR/stack work');
  });
  it('validates an Invoker plan for MCP without submitting it', async () => {
    const result = await validatePlanForMcp(fixturePlan);

    expect(result).toEqual({ ok: true, name: 'Hello World CLI', taskCount: 1 });
  });

  it('returns MCP validation errors for broken YAML', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'invoker-cli-mcp-invalid-'));
    const invalidPlan = join(dir, 'invalid.yaml');
    writeFileSync(invalidPlan, 'name: [broken\n', 'utf8');

    const result = await validatePlanForMcp(invalidPlan);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Invalid YAML');
  });

  it('resolveCliInvocation spawns a compiled binary directly when cliPath equals execPath', () => {
    const result = resolveCliInvocation(
      '/v/invoker-cli',
      '/v/invoker-cli',
      ['run', fixturePlan, '--live', '--json'],
    );

    expect(result).toEqual({
      command: '/v/invoker-cli',
      args: ['run', fixturePlan, '--live', '--json'],
    });
  });

  it('resolveCliInvocation prepends the JS entry path in dev mode', () => {
    const result = resolveCliInvocation(
      '/usr/bin/node',
      '/repo/dist/index.js',
      ['run', fixturePlan, '--json'],
    );

    expect(result).toEqual({
      command: '/usr/bin/node',
      args: ['/repo/dist/index.js', 'run', fixturePlan, '--json'],
    });
  });

  it('submits MCP plans in live mode by default', async () => {
    const calls: string[][] = [];
    const runner: McpCliRunner = {
      async run(args) {
        calls.push(args);
        return { exitCode: 0, stdout: '{"workflow":{"id":"wf-live"}}\n', stderr: '' };
      },
    };

    const result = await submitPlanForMcp(fixturePlan, undefined, runner);

    expect(result).toEqual({ ok: true, workflowId: 'wf-live', stdout: '{"workflow":{"id":"wf-live"}}\n' });
    expect(calls).toEqual([['run', fixturePlan, '--live', '--json']]);
  });
  it('rejects MCP submit output that is not one JSON result', async () => {
    const runner: McpCliRunner = {
      async run() {
        return { exitCode: 0, stdout: 'task log\n{"workflow":{"id":"wf-live"}}\n', stderr: '' };
      },
    };

    const result = await submitPlanForMcp(fixturePlan, undefined, runner);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Invalid invoker-cli run --json output');
  });

  it('returns MCP submit process failures with stdout and stderr', async () => {
    const runner: McpCliRunner = {
      async run() {
        return { exitCode: 42, stdout: '{"partial":true}\n', stderr: 'boom\n' };
      },
    };

    const result = await submitPlanForMcp(fixturePlan, undefined, runner);

    expect(result).toEqual({
      ok: false,
      exitCode: 42,
      stdout: '{"partial":true}\n',
      stderr: 'boom\n',
    });
  });


  it('submits MCP plans in auto mode without live or standalone flags', async () => {
    const calls: string[][] = [];
    const runner: McpCliRunner = {
      async run(args) {
        calls.push(args);
        return { exitCode: 0, stdout: '{"workflow":{"id":"wf-auto"}}\n', stderr: '' };
      },
    };

    const result = await submitPlanForMcp(fixturePlan, 'auto', runner);

    expect(result.ok).toBe(true);
    expect(calls).toEqual([['run', fixturePlan, '--json']]);
  });

  it('submits MCP plans in standalone mode with standalone JSON args', async () => {
    const calls: string[][] = [];
    const runner: McpCliRunner = {
      async run(args) {
        calls.push(args);
        return { exitCode: 0, stdout: '{"workflow":{"id":"wf-standalone"}}\n', stderr: '' };
      },
    };

    const result = await submitPlanForMcp(fixturePlan, 'standalone', runner);

    expect(result.ok).toBe(true);
    expect(calls).toEqual([['run', fixturePlan, '--standalone', '--json']]);
  });
  it('rejects --db-dir with --live', async () => {
    const output = captureProcessOutput();
    const dbDir = mkdtempSync(join(tmpdir(), 'invoker-cli-live-db-'));

    const code = await main(['run', fixturePlan, '--live', '--db-dir', dbDir]);

    expect(code).toBe(1);
    expect(output.stderr).toContain('--db-dir cannot be used with --live');
    output.restore();
  });
});
