import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

vi.mock('xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon(): void {}
    open(): void {}
    write(): void {}
    focus(): void {}
    dispose(): void {}
    onData(): { dispose: () => void } {
      return { dispose: () => {} };
    }
  },
}));

vi.mock('xterm-addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  },
}));

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
    const expandPlanningChats = screen.queryByRole('button', { name: 'Expand planning chats' });
    if (expandPlanningChats) fireEvent.click(expandPlanningChats);
    fireEvent.click(await screen.findByRole('button', { name: 'Options' }));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });
  }

  function submitPlanningText(text: string) {
    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: text } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
  }

  it('reproduces chat-to-chat preset ownership drift after selecting a restored chat', async () => {
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'chat-codex',
          title: 'Codex chat',
          status: 'still_discussing',
          presetKey: 'codex',
          messages: [
            { id: 1, role: 'assistant', text: 'Codex restored reply.', createdAt: '2026-07-26T00:00:01.000Z' },
          ],
          draftPlanAvailable: false,
          draftPlanSummary: undefined,
          draftPlanText: undefined,
          updatedAt: '2026-07-26T00:00:03.000Z',
        }),
        makePlanningSessionSummary({
          id: 'chat-claude',
          title: 'Claude chat',
          status: 'still_discussing',
          presetKey: 'omp+claude',
          messages: [
            { id: 1, role: 'assistant', text: 'Claude restored reply.', createdAt: '2026-07-26T00:00:02.000Z' },
          ],
          draftPlanAvailable: false,
          draftPlanSummary: undefined,
          draftPlanText: undefined,
          updatedAt: '2026-07-26T00:00:02.000Z',
        }),
      ],
    }));
    mock.api.planningChatSend = vi.fn(async (request: any) => ({
      ok: true,
      sessionId: request.sessionId,
      reply: 'Continued.',
      draftPlanAvailable: false,
    })) as any;

    render(<App />);
    await openPlanningTerminal();

    const rail = await screen.findByTestId('planning-session-list');
    fireEvent.click(within(rail).getByText('Claude chat'));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Claude restored reply.');
    });

    expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    submitPlanningText('continue with saved preset');

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledWith({
        sessionId: 'chat-claude',
        message: 'continue with saved preset',
        presetKey: 'codex',
      });
    });
  });

  it('passes a changed local preset when opening tmux before the first chat send', async () => {
    mock.api.planningChatCreate = vi.fn(async (request: any) => ({
      ok: true,
      session: makePlanningSessionSummary({
        id: 'tmux-created-from-local',
        title: request.title ?? 'Untitled plan',
        status: 'still_discussing',
        presetKey: request.presetKey ?? 'codex',
        messages: [],
        draftPlanAvailable: false,
        draftPlanSummary: undefined,
        draftPlanText: undefined,
      }),
    })) as any;
    mock.api.planningTerminalOpen = vi.fn(async (planningSessionId: string) => ({
      opened: true,
      session: {
        sessionId: 'tmux-created-terminal',
        taskId: `planning:${planningSessionId}`,
        kind: 'planning',
        planningSessionId,
        status: 'running',
        cwd: '/repo',
        mode: 'spawn',
        attached: false,
        createdAt: '2026-07-26T00:00:00.000Z',
        outputSnapshot: '',
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
      });
      expect(mock.api.planningTerminalOpen).toHaveBeenCalledWith('tmux-created-from-local');
    });
    expect(await screen.findByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', 'tmux-created-terminal');
  });
});
