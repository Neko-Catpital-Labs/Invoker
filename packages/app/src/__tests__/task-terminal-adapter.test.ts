import { describe, expect, it, vi } from 'vitest';
import { ExecutorRegistry } from '@invoker/execution-engine';
import { createTaskTerminalAdapter } from '../task-terminal-adapter.js';

describe('createTaskTerminalAdapter', () => {
  it('resolves persistence lazily for open-terminal calls', async () => {
    let persistence:
      | {
          getTaskStatus(taskId: string): string | null;
          listTerminalSessions(): [];
          deleteTerminalSession(sessionId: string): void;
        }
      | undefined;
    let executorRegistry: ExecutorRegistry | undefined;

    const adapter = createTaskTerminalAdapter({
      getPersistence: () => persistence as never,
      getExecutorRegistry: () => executorRegistry,
      repoRoot: '/repo',
      taskHandles: new Map(),
      embeddedTerminalManager: {
        list: vi.fn(() => []),
        get: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        close: vi.fn(() => ({ ok: true })),
        openOrReuse: vi.fn(),
      } as never,
      uiPerfStats: {} as never,
      terminalUiPerf: {} as never,
      terminalUiPerfSink: {} as never,
    });

    persistence = {
      getTaskStatus: vi.fn(() => null),
      listTerminalSessions: vi.fn(() => []),
      deleteTerminalSession: vi.fn(),
    };
    executorRegistry = new ExecutorRegistry();

    expect(await adapter.open('task-1')).toEqual({
      opened: false,
      reason: 'Task "task-1" not found.',
    });
    expect(persistence.getTaskStatus).toHaveBeenCalledWith('task-1');
  });
});
