import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

describe('planning terminal preset ownership repro', () => {
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
    if (!screen.queryByTestId('invoker-terminal-harness')) {
      fireEvent.click(await screen.findByRole('button', { name: 'Options' }));
    }
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toBeInTheDocument();
    });
  }

  function submitPlanningText(text: string) {
    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: text } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
  }

  it('uses the active chat preset when sending immediately after switching chats', async () => {
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'codex-chat',
          title: 'Codex chat',
          status: 'still_discussing',
          presetKey: 'codex',
          draftPlanAvailable: false,
          draftPlanSummary: undefined,
          draftPlanText: undefined,
          updatedAt: '2026-07-26T00:00:01.000Z',
        }),
        makePlanningSessionSummary({
          id: 'claude-chat',
          title: 'Claude chat',
          status: 'still_discussing',
          presetKey: 'omp+claude',
          draftPlanAvailable: false,
          draftPlanSummary: undefined,
          draftPlanText: undefined,
          updatedAt: '2026-07-26T00:00:00.000Z',
        }),
      ],
    }));
    mock.api.planningChatSend = vi.fn(async (request: any) => ({
      ok: true,
      sessionId: request.sessionId,
      reply: 'Reply from active chat.',
      draftPlanAvailable: false,
    })) as any;

    render(<App />);
    await openPlanningTerminal();

    const rail = screen.getByTestId('planning-session-list');
    const claudeChatButton = within(rail).getByText('Claude chat').closest('button');
    if (!claudeChatButton) throw new Error('Missing Claude chat button');

    fireEvent.click(claudeChatButton);
    submitPlanningText('continue with claude');

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledWith({
        turnId: expect.any(String),
        sessionId: 'claude-chat',
        message: 'continue with claude',
        presetKey: 'omp+claude',
        confirmationMode: 'require',
      });
    });
  });

  it('uses a preset changed before opening tmux when creating the backing chat session', async () => {
    mock.api.planningChatCreate = vi.fn(async () => ({
      ok: true,
      session: makePlanningSessionSummary({
        id: 'tmux-created-with-claude',
        title: 'Untitled plan',
        status: 'still_discussing',
        presetKey: 'omp+claude',
        draftPlanAvailable: false,
        draftPlanSummary: undefined,
        draftPlanText: undefined,
        terminalMode: 'chat',
      }),
    })) as any;
    mock.api.planningTerminalOpen = vi.fn(async (planningSessionId: string) => ({
      opened: true,
      session: {
        sessionId: `terminal-${planningSessionId}`,
        taskId: `planning:${planningSessionId}`,
        kind: 'planning',
        planningSessionId,
        status: 'running',
        mode: 'spawn',
        attached: false,
        createdAt: '2026-07-26T00:00:00.000Z',
        outputSnapshot: '',
      },
    })) as any;

    render(<App />);
    await openPlanningTerminal();

    fireEvent.change(screen.getByTestId('invoker-terminal-harness'), {
      target: { value: 'omp' },
    });
    await waitFor(() => expect(screen.getByTestId('invoker-terminal-model')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('invoker-terminal-model'), {
      target: { value: 'omp+claude' },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Tmux' }));

    await waitFor(() => {
      expect(mock.api.planningChatCreate).toHaveBeenCalledWith({
        presetKey: 'omp+claude',
        title: 'Untitled plan',
        confirmationMode: 'require',
      });
      expect(mock.api.planningTerminalOpen).toHaveBeenCalledWith('tmux-created-with-claude');
    });
  });

  it('sends a changed model preset on an existing chat without replacing the conversation', async () => {
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'existing-chat',
          title: 'Existing chat',
          status: 'still_discussing',
          presetKey: 'codex',
          draftPlanAvailable: false,
          draftPlanSummary: undefined,
          draftPlanText: undefined,
          updatedAt: '2026-07-26T00:00:00.000Z',
        }),
      ],
    }));
    mock.api.planningChatSend = vi.fn(async (request: any) => ({
      ok: true,
      sessionId: request.sessionId,
      reply: 'Reply from the selected model.',
      draftPlanAvailable: false,
    })) as any;

    render(<App />);
    await openPlanningTerminal();

    fireEvent.change(screen.getByTestId('invoker-terminal-harness'), {
      target: { value: 'omp' },
    });
    await waitFor(() => expect(screen.getByTestId('invoker-terminal-model')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('invoker-terminal-model'), {
      target: { value: 'omp+claude' },
    });
    submitPlanningText('continue with a different model');

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledWith({
        turnId: expect.any(String),
        sessionId: 'existing-chat',
        message: 'continue with a different model',
        presetKey: 'omp+claude',
        confirmationMode: 'require',
      });
    });
  });
});
