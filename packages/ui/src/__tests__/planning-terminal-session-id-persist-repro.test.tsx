import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { InAppPlanningChatResponse } from '@invoker/contracts';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

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

// Expected failure: a failed first planning send may still return the real
// backend session id, but the renderer keeps the local placeholder id. Opening
// tmux after that creates a second planning session instead of reusing the real
// one that owns the failed turn.
describe('planning terminal session id persistence repro', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  async function openPlanningTerminal() {
    fireEvent.click(await screen.findByTestId('sidebar-home'));
    fireEvent.click(await screen.findByRole('button', { name: 'Options' }));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });
  }

  it.fails('opens tmux against the real session id returned by a failed first send', async () => {
    const failedFirstSend: InAppPlanningChatResponse = {
      ok: false,
      sessionId: 'real-session-after-failure',
      error: 'Planner failed after creating the conversation.',
    };
    mock.api.planningChatSend = vi.fn(async () => failedFirstSend) as any;

    render(<App />);
    await openPlanningTerminal();

    fireEvent.change(screen.getByTestId('invoker-terminal-input'), {
      target: { value: 'draft a plan that fails after session creation' },
    });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);

    await screen.findByText('Planner failed after creating the conversation.');
    fireEvent.click(screen.getByRole('tab', { name: 'Tmux' }));

    await waitFor(() => {
      expect(mock.api.planningTerminalOpen).toHaveBeenCalled();
    });
    expect(mock.api.planningChatCreate).not.toHaveBeenCalled();
    expect(mock.api.planningTerminalOpen).toHaveBeenCalledWith('real-session-after-failure');
  });
});
