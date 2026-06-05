import { describe, expect, it, vi } from 'vitest';
import { createHeadlessExecutor } from '../headless.js';

let capturedTaskRunnerOptions: any;

vi.mock('@invoker/execution-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@invoker/execution-engine')>();
  return {
    ...actual,
    TaskRunner: vi.fn().mockImplementation((options) => {
      capturedTaskRunnerOptions = options;
      return {};
    }),
  };
});

describe('headless output persistence', () => {
  it('persists task output through the unified output API only', () => {
    const appendTaskOutput = vi.fn();
    const appendOutputChunk = vi.fn();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      createHeadlessExecutor({
        logger: {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          child: vi.fn(),
        } as any,
        orchestrator: {} as any,
        persistence: {
          appendTaskOutput,
          appendOutputChunk,
        } as any,
        executorRegistry: {} as any,
        messageBus: {} as any,
        commandService: {} as any,
        repoRoot: '/repo',
        invokerConfig: {} as any,
        initServices: vi.fn(),
        wireSlackBot: vi.fn(),
      });

      capturedTaskRunnerOptions.callbacks.onOutput('task-1', 'hello\n');

      expect(appendTaskOutput).toHaveBeenCalledWith('task-1', 'hello\n');
      expect(appendOutputChunk).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
    }
  });
});
