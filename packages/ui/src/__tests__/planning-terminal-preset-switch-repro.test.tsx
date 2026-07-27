import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { TerminalSessionDescriptor } from '@invoker/contracts';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: vi.fn(() => ({
    fillStyle: '',
    fillRect: vi.fn(),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    getImageData: vi.fn(() => ({ data: [0, 0, 0, 255] })),
  })),
});

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

  function clickPlanningRailSession(title: string) {
    const rail = screen.getByTestId('planning-session-list');
    const titleNode = within(rail).getByText(title);
    const button = titleNode.closest('button');
    if (!button) throw new Error(`Missing planning rail button for "${title}".`);
    fireEvent.click(button);
  }

  it('keeps each chat preset when switching between planning chats', async () => {
    mock.api.planningChatSend = vi.fn(async (request: any) => {
      const sessionId = request.sessionId
        ?? (request.presetKey === 'omp+claude' ? 'claude-session' : 'codex-session');
      return {
        ok: true,
        sessionId,
        reply: `Reply from ${request.presetKey}.`,
        confirmationMode: request.confirmationMode,
        draftPlanAvailable: false,
      };
    }) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('codex session seed');
    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledWith({
        message: 'codex session seed',
        presetKey: 'codex',
        confirmationMode: 'require',
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    fireEvent.change(screen.getByTestId('invoker-terminal-harness'), { target: { value: 'omp+claude' } });
    submitPlanningText('claude session seed');
    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledWith({
        message: 'claude session seed',
        presetKey: 'omp+claude',
        confirmationMode: 'require',
      });
    });

    clickPlanningRailSession('codex session seed');
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });
    submitPlanningText('continue codex');
    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenLastCalledWith({
        sessionId: 'codex-session',
        message: 'continue codex',
        presetKey: 'codex',
        confirmationMode: 'require',
      });
    });

    clickPlanningRailSession('claude session seed');
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('omp+claude');
    });
    submitPlanningText('continue claude');
    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenLastCalledWith({
        sessionId: 'claude-session',
        message: 'continue claude',
        presetKey: 'omp+claude',
        confirmationMode: 'require',
      });
    });
  });

  it('uses the local preset changed immediately before opening tmux', async () => {
    const openedTerminal: TerminalSessionDescriptor = {
      sessionId: 'tmux-created-before-send',
      taskId: 'planning:created-before-tmux',
      kind: 'planning',
      planningSessionId: 'created-before-tmux',
      status: 'running',
      mode: 'spawn',
      attached: false,
      createdAt: '2026-07-07T00:00:02.000Z',
      outputSnapshot: '',
    };
    mock.api.planningChatCreate = vi.fn(async (request: any) => ({
      ok: true,
      session: makePlanningSessionSummary({
        id: 'created-before-tmux',
        title: request.title ?? 'Untitled plan',
        presetKey: request.presetKey,
        confirmationMode: request.confirmationMode,
        status: 'still_discussing',
        draftPlanAvailable: false,
        messages: [],
        terminalMode: 'chat',
      }),
    })) as any;
    mock.api.planningTerminalOpen = vi.fn(async () => ({
      opened: true,
      session: openedTerminal,
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
      expect(mock.api.planningTerminalOpen).toHaveBeenCalledWith('created-before-tmux');
    });
    expect(screen.getByRole('tab', { name: 'Tmux' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', 'tmux-created-before-send');
  });
});
