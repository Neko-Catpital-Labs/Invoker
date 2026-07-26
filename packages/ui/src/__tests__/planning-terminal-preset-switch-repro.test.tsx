import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const xtermMock = vi.hoisted(() => {
  class MockTerminal {
    cols = 80;
    rows = 24;
    loadAddon = vi.fn();
    open = vi.fn((host: HTMLElement) => {
      const terminalElement = document.createElement('div');
      terminalElement.className = 'xterm';
      terminalElement.textContent = 'mock planning tmux';
      host.appendChild(terminalElement);
    });
    write = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    focus = vi.fn();
    dispose = vi.fn();
  }

  class MockFitAddon {
    fit = vi.fn();
  }

  return { Terminal: MockTerminal, FitAddon: MockFitAddon };
});

vi.mock('xterm', () => ({ Terminal: xtermMock.Terminal }));
vi.mock('xterm-addon-fit', () => ({ FitAddon: xtermMock.FitAddon }));

const { App } = await import('../App.js');

async function openPlanningTerminal() {
  fireEvent.click(await screen.findByTestId('sidebar-home'));
  const expandPlanningChats = screen.queryByRole('button', { name: 'Expand planning chats' });
  if (expandPlanningChats) fireEvent.click(expandPlanningChats);
  fireEvent.click(await screen.findByRole('button', { name: 'Options' }));
  await waitFor(() => {
    expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
  });
}

describe('planning terminal preset switching repros', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('repro: switching from a Codex chat to an OMP chat leaves the global preset selector on Codex', async () => {
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'codex-restored-chat',
          title: 'Codex restored chat',
          presetKey: 'codex',
          draftPlanAvailable: false,
        }),
        makePlanningSessionSummary({
          id: 'omp-restored-chat',
          title: 'OMP restored chat',
          presetKey: 'omp+claude',
          draftPlanAvailable: false,
        }),
      ],
    })) as any;

    render(<App />);
    await openPlanningTerminal();
    await waitFor(() => {
      const list = screen.getByTestId('planning-session-list');
      expect(within(list).getByText('Codex restored chat')).toBeInTheDocument();
      expect(within(list).getByText('OMP restored chat')).toBeInTheDocument();
    });

    fireEvent.click(within(screen.getByTestId('planning-session-list')).getByText('OMP restored chat'));

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });
    expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Add README');
  });

  it('repro: changing the preset before opening tmux still creates the session with the chat-owned stale preset', async () => {
    render(<App />);
    await openPlanningTerminal();

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    fireEvent.change(screen.getByTestId('invoker-terminal-harness'), {
      target: { value: 'omp+claude' },
    });
    expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('omp+claude');

    fireEvent.click(screen.getByRole('tab', { name: 'Tmux' }));

    await waitFor(() => {
      expect(mock.api.planningChatCreate).toHaveBeenCalledWith({
        presetKey: 'codex',
        title: 'Untitled plan',
      });
      expect(mock.api.planningTerminalOpen).toHaveBeenCalledWith('session-1');
    });
  });
});
