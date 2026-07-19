import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

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

describe('Planning terminal tmux history', () => {
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
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  async function openPlanningTerminal() {
    fireEvent.click(await screen.findByTestId('sidebar-planning'));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });
  }

  it('restores planning tmux output received while the planning surface is hidden', async () => {
    render(<App />);
    await openPlanningTerminal();

    fireEvent.click(screen.getByRole('tab', { name: 'tmux' }));

    await waitFor(() => {
      expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByTestId('invoker-terminal-tmux-pane')).toHaveAttribute(
      'data-session-id',
      'mock-planning-terminal-session-1',
    );

    xtermMocks.write.mockClear();
    fireEvent.click(screen.getByTestId('sidebar-home'));

    await waitFor(() => {
      expect(screen.queryByTestId('invoker-terminal-tmux-pane')).not.toBeInTheDocument();
    });

    await act(async () => {
      mock.fireTerminalOutput({
        sessionId: 'mock-planning-terminal-session-1',
        taskId: 'planning:session-1',
        kind: 'planning',
        planningSessionId: 'session-1',
        data: 'hidden tmux output\n',
      });
    });
    expect(xtermMocks.write).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('sidebar-planning'));

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute(
        'data-session-id',
        'mock-planning-terminal-session-1',
      );
    });
    await waitFor(() => {
      expect(xtermMocks.write).toHaveBeenCalledWith(expect.stringContaining('hidden tmux output'));
    });
    expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
  });
});
