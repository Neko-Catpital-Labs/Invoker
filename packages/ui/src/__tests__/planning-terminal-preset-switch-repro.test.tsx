import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { InAppPlanningCreateSessionResponse } from '@invoker/contracts';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

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

describe('planning terminal preset ownership repro', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
    vi.restoreAllMocks();
  });

  it.fails('does not leak a new local chat preset back into the initial local chat when switching chat-to-chat', async () => {
    mock.api.planningChatSend = vi.fn(async () => ({
      ok: true,
      sessionId: 'chat-initial-after-switch',
      reply: 'Initial chat continued.',
      draftPlanAvailable: false,
    })) as any;

    render(<App />);
    await openPlanningTerminal();

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    fireEvent.change(screen.getByTestId('invoker-terminal-harness'), { target: { value: 'omp+claude' } });

    const sessionButtons = within(await screen.findByTestId('planning-session-list')).getAllByRole('button');
    fireEvent.click(sessionButtons[1]!);

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });

    submitPlanningText('continue the initial local chat');

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledWith({
        message: 'continue the initial local chat',
        presetKey: 'codex',
        confirmationMode: 'require',
      });
    });
  });

  it('uses a local preset change when creating the planning session before tmux opens', async () => {
    const created: InAppPlanningCreateSessionResponse = {
      ok: true,
      session: makePlanningSessionSummary({
        id: 'created-before-tmux-open',
        title: 'Untitled plan',
        status: 'still_discussing',
        presetKey: 'omp+claude',
        draftPlanAvailable: false,
        messages: [],
      }),
    };
    mock.api.planningChatCreate = vi.fn(async () => created) as any;
    mock.api.planningTerminalOpen = vi.fn(async (planningSessionId: string) => ({
      opened: true,
      session: {
        sessionId: `tmux-${planningSessionId}`,
        taskId: `planning:${planningSessionId}`,
        kind: 'planning',
        planningSessionId,
        status: 'running',
        mode: 'spawn',
        attached: false,
        createdAt: '2026-07-07T00:00:00.000Z',
      },
    })) as any;

    render(<App />);
    await openPlanningTerminal();

    fireEvent.change(screen.getByTestId('invoker-terminal-harness'), { target: { value: 'omp+claude' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Tmux' }));

    await waitFor(() => {
      expect(mock.api.planningChatCreate).toHaveBeenCalledWith({
        presetKey: 'omp+claude',
        title: 'Untitled plan',
        confirmationMode: 'require',
      });
    });
    expect(mock.api.planningTerminalOpen).toHaveBeenCalledWith('created-before-tmux-open');
  });
});
