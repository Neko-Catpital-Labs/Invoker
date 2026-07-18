import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TerminalSessionDescriptor } from '@invoker/contracts';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

const xtermMocks = vi.hoisted(() => ({
  write: vi.fn(),
  open: vi.fn(),
  loadAddon: vi.fn(),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  dispose: vi.fn(),
  focus: vi.fn(),
  fit: vi.fn(),
}));

vi.mock('xterm', () => ({
  Terminal: vi.fn(() => ({
    cols: 80,
    rows: 24,
    loadAddon: xtermMocks.loadAddon,
    open: xtermMocks.open,
    write: xtermMocks.write,
    onData: xtermMocks.onData,
    focus: xtermMocks.focus,
    dispose: xtermMocks.dispose,
  })),
}));

vi.mock('xterm-addon-fit', () => ({
  FitAddon: vi.fn(() => ({
    fit: xtermMocks.fit,
  })),
}));

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

describe('planning terminal tmux history', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    xtermMocks.write.mockClear();
    xtermMocks.open.mockClear();
    xtermMocks.loadAddon.mockClear();
    xtermMocks.onData.mockClear();
    xtermMocks.dispose.mockClear();
    xtermMocks.focus.mockClear();
    xtermMocks.fit.mockClear();
    mock = createMockInvoker();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('keeps restored tmux history across sidebar surface switches', async () => {
    const terminalSession: TerminalSessionDescriptor = {
      sessionId: 'planning-terminal-session-1',
      taskId: 'planning:planning-session-1',
      kind: 'planning',
      planningSessionId: 'planning-session-1',
      status: 'running',
      mode: 'spawn',
      attached: false,
      createdAt: '2026-07-18T00:00:00.000Z',
      outputSnapshot: 'persisted tmux history\n',
    };
    const summary = makePlanningSessionSummary({
      id: 'planning-session-1',
      title: 'Tmux planning session',
      status: 'still_discussing',
      draftPlanAvailable: false,
      draftPlanSummary: undefined,
      terminalMode: 'tmux',
      terminalSessionId: terminalSession.sessionId,
      terminalStatus: terminalSession.status,
      terminalOutputSnapshot: terminalSession.outputSnapshot,
      terminalUpdatedAt: terminalSession.createdAt,
    });

    mock.api.planningChatList = vi.fn(async () => ({ ok: true, sessions: [summary] })) as any;
    mock.api.planningTerminalList = vi.fn(async () => [terminalSession]) as any;
    mock.api.planningTerminalOpen = vi.fn(async () => ({
      opened: false,
      reason: 'restored terminal should be reused',
    })) as any;
    mock.install();

    render(<App />);

    await waitFor(() => {
      expect(mock.api.planningChatList).toHaveBeenCalledTimes(1);
      expect(mock.api.planningTerminalList).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(await screen.findByTestId('sidebar-planning'));

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute(
        'data-session-id',
        terminalSession.sessionId,
      );
    });
    await waitFor(() => {
      expect(xtermMocks.write).toHaveBeenCalledWith(expect.stringContaining('persisted tmux history'));
    });

    xtermMocks.write.mockClear();
    fireEvent.click(screen.getByTestId('sidebar-workflows'));
    await waitFor(() => {
      expect(screen.queryByTestId('invoker-terminal-tmux-pane')).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('sidebar-home'));

    await act(async () => {
      mock.fireTerminalOutput({
        sessionId: terminalSession.sessionId,
        taskId: terminalSession.taskId,
        kind: 'planning',
        planningSessionId: 'planning-session-1',
        data: 'hidden tmux output\n',
      });
    });
    expect(xtermMocks.write).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('sidebar-planning'));

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute(
        'data-session-id',
        terminalSession.sessionId,
      );
    });
    await waitFor(() => {
      expect(xtermMocks.write).toHaveBeenCalledWith(expect.stringContaining('hidden tmux output'));
    });
    const replayedOutput = xtermMocks.write.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(replayedOutput).toContain('persisted tmux history');
    expect(replayedOutput).toContain('hidden tmux output');
    expect(mock.api.planningTerminalOpen).not.toHaveBeenCalled();
  });
});
