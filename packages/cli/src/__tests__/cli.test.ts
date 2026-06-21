import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LocalBus } from '@invoker/transport';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../index.js';

const repoRoot = resolve(__dirname, '../../../..');
const cliPath = resolve(repoRoot, 'packages/cli/dist/index.js');
const fixturePlan = resolve(repoRoot, 'plans/fixtures/hello-world.yaml');

function writeStandalonePlan(dir: string, body: string): string {
  const planPath = join(dir, 'plan.yaml');
  writeFileSync(planPath, body.replace('__REPO_ROOT__', JSON.stringify(repoRoot)), 'utf8');
  return planPath;
}

function runCli(args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
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

describe('invoker-cli', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('--help exits 0', () => {
    const result = runCli(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('invoker-cli run <plan.yaml>');
    expect(result.stdout).toContain('invoker-cli worker autofix [--count <n>]');
  });

  it('lists worker service commands', async () => {
    const output = captureProcessOutput();

    const code = await main(['worker', 'list']);

    expect(code).toBe(0);
    expect(output.stdout).toContain('autofix');
    expect(output.stdout).toContain('Long-running auto-fix recovery worker');
    output.restore();
  });

  it('routes worker autofix through the explicit worker bridge', async () => {
    const output = captureProcessOutput();
    const runWorkerAutofix = vi.fn(async () => 0);

    const code = await main(['worker', 'autofix', '--count', '2', '--interval-ms', '1000'], { runWorkerAutofix });

    expect(code).toBe(0);
    expect(runWorkerAutofix).toHaveBeenCalledWith(['--count', '2', '--interval-ms', '1000'], expect.objectContaining({
      mode: 'auto',
    }));
    expect(output.stderr).toBe('');
    output.restore();
  });

  it('runs the hello-world fixture with an isolated db dir', () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'invoker-cli-test-db-'));
    const result = runCli(['run', fixturePlan, '--standalone', '--db-dir', dbDir]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('hello-from-invoker-cli');
  }, 60_000);

  it('--json emits a successful workflow result object', () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'invoker-cli-json-db-'));
    const result = runCli(['run', fixturePlan, '--standalone', '--db-dir', dbDir, '--json']);
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split('\n');
    const json = JSON.parse(lines[lines.length - 1]);
    expect(json.workflow.status).toBe('success');
  }, 60_000);

  it('invalid YAML exits non-zero with a validation error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'invoker-cli-invalid-'));
    const invalidPlan = join(dir, 'invalid.yaml');
    writeFileSync(invalidPlan, 'name: [broken\n', 'utf8');
    const result = runCli(['run', invalidPlan, '--standalone', '--db-dir', join(dir, 'db')]);
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
  }, 60_000);

  it('auto mode delegates when a GUI owner exists', async () => {
    const output = captureProcessOutput();
    const bus = new LocalBus();
    const runHandler = vi.fn(async () => ({ workflowId: 'wf-auto-live', tasks: [] }));
    const execHandler = vi.fn(async () => ({ ok: true }));
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'gui-1', mode: 'gui' }));
    bus.onRequest('headless.run', runHandler);
    bus.onRequest('headless.exec', execHandler);

    const code = await main(['run', fixturePlan], { createMessageBus: () => bus });

    expect(code).toBe(0);
    expect(runHandler).toHaveBeenCalledTimes(1);
    expect(execHandler).not.toHaveBeenCalled();
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
    output.restore();
  }, 60_000);

  it('standalone prompt-only plans route through the execution engine', () => {
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

    const result = runCli(['run', planPath, '--standalone', '--db-dir', join(dir, 'db'), '--json']);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('Standalone CLI v1 supports command tasks only');
    expect(`${result.stdout}\n${result.stderr}`).toContain('No execution agent registered with name "missing-agent"');
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
