import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  return {
    Terminal: MockTerminal,
    FitAddon: MockFitAddon,
  };
});

vi.mock('xterm', () => ({ Terminal: xtermMock.Terminal }));
vi.mock('xterm-addon-fit', () => ({ FitAddon: xtermMock.FitAddon }));

const { App } = await import('../App.js');

describe('planning-terminal preset ownership repros', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
    vi.restoreAllMocks();
  });

  async function openPlanningTerminal() {
    fireEvent.click(await screen.findByTestId('sidebar-home'));
    const expandPlanningChats = screen.queryByRole('button', { name: 'Expand planning chats' });
    if (expandPlanningChats) fireEvent.click(expandPlanningChats);
    fireEvent.click(await screen.findByRole('button', { name: 'Options' }));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toBeInTheDocument();
    });
  }

  function submitPlanningText(text: string) {
    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: text } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
  }

  // `it.fails`: this asserts the desired chat ownership invariant. Switching
  // between saved planning chats should put the composer preset back on the
  // selected chat's persisted preset before the next send.
  it.fails('keeps chat-to-chat preset switching owned by the selected planning session', async () => {
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'claude-chat',
          title: 'Claude chat',
          status: 'still_discussing',
          presetKey: 'omp+claude',
          draftPlanAvailable: false,
          draftPlanSummary: undefined,
          draftPlanText: undefined,
          messages: [{ id: 1, role: 'user', text: 'Use Claude', createdAt: '2026-07-26T00:00:02.000Z' }],
          updatedAt: '2026-07-26T00:00:02.000Z',
        }),
        makePlanningSessionSummary({
          id: 'codex-chat',
          title: 'Codex chat',
          status: 'still_discussing',
          presetKey: 'codex',
          draftPlanAvailable: false,
          draftPlanSummary: undefined,
          draftPlanText: undefined,
          messages: [{ id: 1, role: 'user', text: 'Use Codex', createdAt: '2026-07-26T00:00:01.000Z' }],
          updatedAt: '2026-07-26T00:00:01.000Z',
        }),
      ],
    })) as any;

    render(<App />);
    await openPlanningTerminal();

    const selector = screen.getByTestId('invoker-terminal-harness');
    await waitFor(() => expect(selector).toHaveValue('omp+claude'));

    const sessionButtons = within(screen.getByTestId('planning-session-list')).getAllByRole('button');
    fireEvent.click(sessionButtons.find((button) => button.textContent?.includes('Codex chat'))!);

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });

    submitPlanningText('continue the codex chat');
    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledWith({
        sessionId: 'codex-chat',
        message: 'continue the codex chat',
        presetKey: 'codex',
      });
    });
  });

  // `it.fails`: this asserts the desired local-chat preset invariant. If a user
  // changes the composer preset before opening tmux, the app session created for
  // the tmux handoff should use that currently selected preset.
  it.fails('uses a preset changed before tmux open when creating the backing planning session', async () => {
    mock.api.planningChatCreate = vi.fn(async ({ presetKey }: { presetKey?: string }) => ({
      ok: true,
      session: makePlanningSessionSummary({
        id: 'created-for-tmux',
        title: 'Tmux handoff',
        status: 'still_discussing',
        presetKey: presetKey ?? 'codex',
        draftPlanAvailable: false,
        draftPlanSummary: undefined,
        draftPlanText: undefined,
      }),
    })) as any;

    render(<App />);
    await openPlanningTerminal();

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    fireEvent.change(screen.getByTestId('invoker-terminal-harness'), { target: { value: 'omp+claude' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Tmux' }));

    await waitFor(() => {
      expect(mock.api.planningChatCreate).toHaveBeenCalledWith({
        presetKey: 'omp+claude',
        title: 'Untitled plan',
      });
    });
    expect(mock.api.planningTerminalOpen).toHaveBeenCalledWith('created-for-tmux');
  });
});
