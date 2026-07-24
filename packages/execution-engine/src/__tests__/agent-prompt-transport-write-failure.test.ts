import { afterEach, describe, expect, it, vi } from 'vitest';

describe('materializeLocalAgentPrompt write failure cleanup', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('node:fs');
  });

  it('removes the temporary directory when prompt file writing fails', async () => {
    const writeError = new Error('disk full');
    const rmSync = vi.fn();
    const mkdtempSync = vi.fn(() => '/tmp/invoker-agent-prompt-test-1234');
    const writeFileSync = vi.fn(() => {
      throw writeError;
    });

    vi.doMock('node:fs', async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return {
        ...actual,
        mkdtempSync,
        rmSync,
        writeFileSync,
      };
    });

    // Dynamic import is required here because this test replaces node:fs before loading the module under test.
    const { materializeLocalAgentPrompt } = await import('../agent-prompt-transport.js');

    expect(() => materializeLocalAgentPrompt('running task context\n'.repeat(10_000))).toThrow(writeError);
    expect(rmSync).toHaveBeenCalledOnce();
    expect(rmSync).toHaveBeenCalledWith('/tmp/invoker-agent-prompt-test-1234', { recursive: true, force: true });
  });

  it('returns cleanup metadata when removing the spilled prompt directory fails', async () => {
    const cleanupError = new Error('device busy');
    const rmSync = vi.fn(() => {
      throw cleanupError;
    });
    const mkdtempSync = vi.fn(() => '/tmp/invoker-agent-prompt-test-5678');
    const writeFileSync = vi.fn();

    vi.doMock('node:fs', async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return {
        ...actual,
        mkdtempSync,
        rmSync,
        writeFileSync,
      };
    });

    const { materializeLocalAgentPrompt } = await import('../agent-prompt-transport.js');
    const transport = materializeLocalAgentPrompt('running task context\n'.repeat(10_000));

    expect(transport.cleanup()).toEqual({
      directory: '/tmp/invoker-agent-prompt-test-5678',
      error: cleanupError,
    });
    expect(rmSync).toHaveBeenCalledOnce();
    expect(rmSync).toHaveBeenCalledWith('/tmp/invoker-agent-prompt-test-5678', { recursive: true, force: true });
  });
});
