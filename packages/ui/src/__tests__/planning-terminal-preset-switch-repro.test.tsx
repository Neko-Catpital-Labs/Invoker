import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: vi.fn(() => null),
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

  it('uses each restored chat session preset when switching chat to chat', async () => {
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'codex-chat',
          title: 'Codex chat',
          status: 'still_discussing',
          presetKey: 'codex',
          draftPlanAvailable: false,
          messages: [{ id: 1, role: 'user', text: 'Codex turn', createdAt: '2026-07-07T00:00:01.000Z' }],
        }),
        makePlanningSessionSummary({
          id: 'omp-chat',
          title: 'OMP chat',
          status: 'still_discussing',
          presetKey: 'omp+claude',
          draftPlanAvailable: false,
          messages: [{ id: 2, role: 'user', text: 'OMP turn', createdAt: '2026-07-07T00:00:02.000Z' }],
        }),
      ],
    }));
    mock.api.planningChatSend = vi.fn(async (request: any) => ({
      ok: true,
      sessionId: request.sessionId,
      reply: `Continued ${request.sessionId}.`,
      confirmationMode: 'require',
      draftPlanAvailable: false,
    })) as any;

    render(<App />);
    await openPlanningTerminal();

    const rail = await screen.findByTestId('planning-session-list');
    fireEvent.click(within(rail).getByText('OMP chat'));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('omp+claude');
    });
    submitPlanningText('continue omp chat');
    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenLastCalledWith({
        sessionId: 'omp-chat',
        message: 'continue omp chat',
        presetKey: 'omp+claude',
        confirmationMode: 'require',
      });
    });

    fireEvent.click(within(rail).getByText('Codex chat'));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });
    submitPlanningText('continue codex chat');
    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenLastCalledWith({
        sessionId: 'codex-chat',
        message: 'continue codex chat',
        presetKey: 'codex',
        confirmationMode: 'require',
      });
    });
  });

  it('uses a changed local preset when opening tmux before the first chat send', async () => {
    mock.api.planningChatCreate = vi.fn(async (request: any) => ({
      ok: true,
      session: {
        id: 'created-before-tmux-open',
        title: request.title,
        status: 'still_discussing',
        presetKey: request.presetKey,
        confirmationMode: request.confirmationMode,
        messages: [],
        draftPlanAvailable: false,
        terminalMode: 'chat',
        createdAt: '2026-07-07T00:00:00.000Z',
        updatedAt: '2026-07-07T00:00:00.000Z',
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
      expect(mock.api.planningTerminalOpen).toHaveBeenCalledWith('created-before-tmux-open');
    });
  });
});
