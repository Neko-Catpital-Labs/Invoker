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

  return { Terminal: MockTerminal, FitAddon: MockFitAddon };
});

vi.mock('xterm', () => ({ Terminal: xtermMock.Terminal }));
vi.mock('xterm-addon-fit', () => ({ FitAddon: xtermMock.FitAddon }));

const { App } = await import('../App.js');

describe('planning terminal preset ownership repros', () => {
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

  function submitPlanningText(text: string) {
    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: text } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
  }

  it('keeps the active restored chat preset when switching chat to chat', async () => {
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'codex-chat',
          title: 'Codex chat',
          presetKey: 'codex',
          draftPlanAvailable: false,
          messages: [
            { id: 1, role: 'assistant', text: 'Codex transcript.', createdAt: '2026-07-07T00:00:01.000Z' },
          ],
        }),
        makePlanningSessionSummary({
          id: 'claude-chat',
          title: 'Claude chat',
          presetKey: 'omp+claude',
          draftPlanAvailable: false,
          messages: [
            { id: 1, role: 'assistant', text: 'Claude transcript.', createdAt: '2026-07-07T00:00:02.000Z' },
          ],
        }),
      ],
    }));

    render(<App />);
    await openPlanningTerminal();
    await waitFor(() => {
      expect(screen.getByTestId('planning-session-rail')).toHaveTextContent('2 chats');
    });

    fireEvent.click(within(screen.getByTestId('planning-session-list')).getByRole('button', { name: /Claude chat/ }));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('omp+claude');
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Claude transcript.');
    });

    submitPlanningText('continue with the selected chat preset');

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledWith({
        sessionId: 'claude-chat',
        message: 'continue with the selected chat preset',
        presetKey: 'omp+claude',
        confirmationMode: 'require',
      });
    });
  });

  it('passes a local preset change into the session created before tmux open', async () => {
    mock.api.planningChatCreate = vi.fn(async (request) => ({
      ok: true,
      session: {
        id: 'created-for-tmux',
        title: request?.title ?? 'Untitled plan',
        status: 'still_discussing',
        presetKey: request?.presetKey ?? 'codex',
        confirmationMode: request?.confirmationMode ?? 'require',
        messages: [],
        draftPlanAvailable: false,
        createdAt: '2026-07-07T00:00:00.000Z',
        updatedAt: '2026-07-07T00:00:00.000Z',
      },
    })) as any;
    mock.api.planningTerminalOpen = vi.fn(async (planningSessionId: string) => ({
      opened: true,
      session: {
        sessionId: `term-${planningSessionId}`,
        taskId: `planning:${planningSessionId}`,
        kind: 'planning',
        planningSessionId,
        status: 'running',
        mode: 'spawn',
        attached: false,
        createdAt: '2026-07-07T00:00:01.000Z',
      },
    })) as any;

    render(<App />);
    await openPlanningTerminal();

    fireEvent.change(screen.getByTestId('invoker-terminal-harness'), { target: { value: 'omp+claude' } });
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('omp+claude');
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Tmux' }));

    await waitFor(() => {
      expect(mock.api.planningChatCreate).toHaveBeenCalledWith({
        presetKey: 'omp+claude',
        title: 'Untitled plan',
        confirmationMode: 'require',
      });
      expect(mock.api.planningTerminalOpen).toHaveBeenCalledWith('created-for-tmux');
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', 'term-created-for-tmux');
    });
  });
});
