import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:sea', () => ({ isSea: vi.fn(() => false) }));

const spawnCalls: unknown[][] = [];
const spawnMock = vi.fn((...args: unknown[]) => {
  spawnCalls.push(args);
  return {
    stdout: { setEncoding: () => {}, on: () => {} },
    stderr: { setEncoding: () => {}, on: () => {} },
    once: (event: string, cb: (code: number) => void) => {
      if (event === 'close') cb(0);
    },
  } as never;
});
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

afterEach(() => {
  spawnCalls.length = 0;
  spawnMock.mockClear();
});

describe('createProcessRunner SEA-aware default cliPath', () => {
  it('defaults to execPath (no extra prepend) when running as a packaged SEA binary', async () => {
    const sea = await import('node:sea');
    vi.mocked(sea.isSea).mockReturnValue(true);
    const originalArgv1 = process.argv[1];
    process.argv[1] = 'invoker-cli';
    vi.resetModules();
    const { createProcessRunner } = await import('../mcp-server.js');
    const runner = createProcessRunner();
    await runner.run(['run', '/tmp/plan.yaml', '--live', '--json']);
    expect(spawnCalls.length).toBe(1);
    const [command, args] = spawnCalls[0] as [string, string[]];
    expect(command).toBe(process.execPath);
    expect(args).toEqual(['run', '/tmp/plan.yaml', '--live', '--json']);
    process.argv[1] = originalArgv1;
  });

  it('keeps prepending the real script path in dev mode (non-SEA)', async () => {
    const sea = await import('node:sea');
    vi.mocked(sea.isSea).mockReturnValue(false);
    const originalArgv1 = process.argv[1];
    process.argv[1] = '/repo/dist/index.js';
    vi.resetModules();
    const { createProcessRunner } = await import('../mcp-server.js');
    const runner = createProcessRunner();
    await runner.run(['run', '/tmp/plan.yaml', '--json']);
    expect(spawnCalls.length).toBe(1);
    const [command, args] = spawnCalls[0] as [string, string[]];
    expect(command).toBe(process.execPath);
    expect(args).toEqual(['/repo/dist/index.js', 'run', '/tmp/plan.yaml', '--json']);
    process.argv[1] = originalArgv1;
  });
});
