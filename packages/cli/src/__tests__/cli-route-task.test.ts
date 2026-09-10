import { LocalBus } from '@invoker/transport';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../index.js';

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

function busWithOwner(execHandler: (request: unknown) => Promise<unknown>): LocalBus {
  const bus = new LocalBus();
  bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
  bus.onRequest('headless.exec', execHandler);
  return bus;
}

describe('invoker-cli route-task', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [['--agent', 'codex'], ['route-task', 'wf-1/task-1', '--agent', 'codex']],
    [['--pool', 'pool-remote'], ['route-task', 'wf-1/task-1', '--pool', 'pool-remote']],
    [['--runner', 'ssh'], ['route-task', 'wf-1/task-1', '--runner', 'ssh']],
    [['--clear-member'], ['route-task', 'wf-1/task-1', '--clear-member']],
    [['--agent', 'claude', '--force'], ['route-task', 'wf-1/task-1', '--agent', 'claude', '--force']],
  ])('forwards %j over headless.exec and waits for the owner result', async (flags, expectedArgs) => {
    const output = captureProcessOutput();
    const execHandler = vi.fn(async (request: unknown) => {
      expect(request).toEqual({ args: expectedArgs, noTrack: false });
      return { ok: true };
    });
    const bus = busWithOwner(execHandler);

    const code = await main(['route-task', 'wf-1/task-1', ...flags], { createMessageBus: () => bus });

    expect(code).toBe(0);
    expect(execHandler).toHaveBeenCalledTimes(1);
    expect(output.stdout).toContain('route-task applied by live owner.');
    output.restore();
  });

  it('forwards every flag together in a canonical order', async () => {
    const output = captureProcessOutput();
    const execHandler = vi.fn(async () => ({ ok: true }));
    const bus = busWithOwner(execHandler);

    const code = await main(
      ['route-task', '--clear-member', '--runner', 'ssh', 'wf-1/task-1', '--agent', 'codex', '--pool', 'p-1'],
      { createMessageBus: () => bus },
    );

    expect(code).toBe(0);
    expect(execHandler).toHaveBeenCalledWith({
      args: ['route-task', 'wf-1/task-1', '--agent', 'codex', '--pool', 'p-1', '--runner', 'ssh', '--clear-member'],
      noTrack: false,
    });
    output.restore();
  });

  it.each([
    [['route-task'], 'Missing taskId.'],
    [['route-task', 'wf-1/task-1'], 'Nothing to change.'],
    [['route-task', 'wf-1/task-1', '--agent'], 'Missing value for --agent.'],
    [['route-task', 'wf-1/task-1', '--pool', '--runner', 'ssh'], 'Missing value for --pool.'],
    [['route-task', 'wf-1/task-1', '--runner', 'docker'], 'Unsupported --runner value "docker".'],
    [['route-task', 'wf-1/task-1', '--nope'], 'Unknown option: --nope.'],
    [['route-task', 'wf-1/task-1', 'wf-1/task-2', '--agent', 'codex'], 'Unexpected argument: wf-1/task-2.'],
  ])('rejects %j before contacting the owner', async (argv, expectedMessage) => {
    const output = captureProcessOutput();
    const execHandler = vi.fn(async () => ({ ok: true }));
    const bus = busWithOwner(execHandler);

    const code = await main(argv, { createMessageBus: () => bus });

    expect(code).toBe(1);
    expect(output.stderr).toContain(expectedMessage);
    expect(execHandler).not.toHaveBeenCalled();
    output.restore();
  });

  it('surfaces an owner-side refusal as a non-zero exit', async () => {
    const output = captureProcessOutput();
    const bus = busWithOwner(async () => {
      throw new Error('Cannot route task "wf-1/task-1" to agent "nope": no execution agent is registered under that name. Available: [claude, codex]');
    });

    const code = await main(['route-task', 'wf-1/task-1', '--agent', 'nope'], { createMessageBus: () => bus });

    expect(code).toBe(1);
    expect(output.stderr).toContain('no execution agent is registered under that name');
    output.restore();
  });

  it('refuses to route when no live owner is reachable', async () => {
    const output = captureProcessOutput();
    const bus = new LocalBus();

    const code = await main(['route-task', 'wf-1/task-1', '--agent', 'codex'], { createMessageBus: () => bus });

    expect(code).toBe(1);
    expect(output.stderr).toContain('No running Invoker owner is reachable');
    output.restore();
  });

  it('documents route-task in the CLI help text', async () => {
    const output = captureProcessOutput();

    const code = await main(['--help'], {});

    expect(code).toBe(0);
    expect(output.stdout).toContain('invoker-cli route-task <taskId>');
    expect(output.stdout).toContain('--clear-member');
    output.restore();
  });
});
