import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { InAppPlanningListSessionsResponse, TerminalSessionDescriptor } from '@invoker/contracts';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

describe('planning terminal startup hydrate race repro', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('keeps the terminal-aware hydrate result when the startup chat list resolves late', async () => {
    let resolveLateStartupList: (value: InAppPlanningListSessionsResponse) => void = () => {};
    const lateStartupList = new Promise<InAppPlanningListSessionsResponse>((resolve) => {
      resolveLateStartupList = resolve;
    });
    const liveTerminal: TerminalSessionDescriptor = {
      sessionId: 'live-terminal-for-race-chat',
      taskId: 'planning:race-chat',
      kind: 'planning',
      planningSessionId: 'race-chat',
      status: 'running',
      cwd: '/repo',
      mode: 'spawn',
      attached: false,
      createdAt: '2026-07-26T00:00:03.000Z',
      outputSnapshot: 'live hydrate output\n',
    };

    mock.api.planningChatList = vi
      .fn()
      .mockImplementationOnce(() => lateStartupList)
      .mockResolvedValueOnce({
        ok: true,
        sessions: [
          makePlanningSessionSummary({
            id: 'race-chat',
            title: 'Terminal-aware hydrate',
            status: 'still_discussing',
            draftPlanAvailable: false,
            terminalMode: 'tmux',
            terminalSessionId: 'stale-terminal-from-summary',
            terminalStatus: 'running',
            terminalOutputSnapshot: 'stale persisted output\n',
          }),
        ],
      }) as any;
    mock.api.planningTerminalList = vi.fn(async () => [liveTerminal]) as any;

    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-home'));

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute(
        'data-session-id',
        'live-terminal-for-race-chat',
      );
    });

    await act(async () => {
      resolveLateStartupList({
        ok: true,
        sessions: [
          makePlanningSessionSummary({
            id: 'race-chat',
            title: 'Late chat-only hydrate',
            status: 'still_discussing',
            draftPlanAvailable: false,
            terminalMode: 'chat',
            terminalSessionId: undefined,
          }),
        ],
      });
      await lateStartupList;
    });

    expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute(
      'data-session-id',
      'live-terminal-for-race-chat',
    );
    expect(screen.getAllByText('Terminal-aware hydrate').length).toBeGreaterThan(0);
  });
});
