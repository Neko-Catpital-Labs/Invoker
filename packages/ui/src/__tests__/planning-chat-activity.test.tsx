import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';
import type { InAppPlanningTurnActivity } from '@invoker/contracts';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

vi.mock('xterm', () => ({
  Terminal: class {
    loadAddon() {}
    open() {}
    write() {}
    onData() { return { dispose() {} }; }
    focus() {}
    refresh() {}
    dispose() {}
  },
}));

vi.mock('xterm-addon-fit', () => ({
  FitAddon: class {
    activate() {}
    proposeDimensions() { return { cols: 80, rows: 24 }; }
    fit() {}
  },
}));

const { App } = await import('../App.js');

async function openPlanningTerminal(): Promise<void> {
  fireEvent.click(await screen.findByTestId('sidebar-home'));
  const expandPlanningChats = screen.queryByRole('button', { name: 'Expand planning chats' });
  if (expandPlanningChats) fireEvent.click(expandPlanningChats);
  fireEvent.click(await screen.findByRole('button', { name: 'Options' }));
  await waitFor(() => {
    expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
  });
}

function submitPlanningText(text: string): void {
  fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: text } });
  fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
}

function sentTurnId(mock: MockInvoker, index = 0): string {
  const turnId = mock.api.planningChatSend.mock.calls[index]?.[0]?.turnId;
  expect(typeof turnId).toBe('string');
  return turnId;
}

function exactText(text: string): (_content: string, element: Element | null) => boolean {
  return (_content, element) => element?.tagName === 'CODE' && element.textContent === text;
}

function restoredActivity(overrides: Partial<InAppPlanningTurnActivity> = {}): InAppPlanningTurnActivity {
  return {
    sessionId: 'saved-planning-1',
    turnId: 'turn-restored',
    userMessageId: 1,
    assistantMessageId: 2,
    status: 'completed',
    startedAt: '2026-07-07T00:00:01.100Z',
    updatedAt: '2026-07-07T00:00:02.000Z',
    completedAt: '2026-07-07T00:00:02.000Z',
    retainedBytes: 23,
    droppedBytes: 0,
    truncated: false,
    events: [
      {
        sequence: 1,
        source: 'stdout',
        text: 'restored stdout\n  exact\n',
        byteCount: 24,
        createdAt: '2026-07-07T00:00:01.200Z',
      },
    ],
    ...overrides,
  };
}

describe('planning chat verbose activity', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('keeps live raw activity hidden by default and shows exact chunks when verbose is opened', async () => {
    let resolveSend: ((value: any) => void) | null = null;
    mock.api.planningChatSend = vi.fn(() => new Promise((resolve) => {
      resolveSend = resolve;
    }) as any) as any;

    render(<App />);
    await openPlanningTerminal();
    submitPlanningText('draft with activity');
    await waitFor(() => expect(mock.api.planningChatSend).toHaveBeenCalledTimes(1));
    const turnId = sentTurnId(mock);

    const stdout = 'stdout line\n  preserved spacing\n';
    const stderr = 'stderr secret=value\n';
    const reasoning = 'provider-visible reason\n';
    await act(async () => {
      mock.firePlanningChatStream({ sessionId: 'session-1', turnId, source: 'stdout', sequence: 1, chunk: stdout });
      mock.firePlanningChatStream({ sessionId: 'session-1', turnId, source: 'stderr', sequence: 2, chunk: stderr });
      mock.firePlanningChatStream({ sessionId: 'session-1', turnId, source: 'reasoning', sequence: 3, chunk: reasoning });
    });

    expect(screen.queryByTestId('planning-turn-activity')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Verbose' }));
    expect(screen.getByTestId('planning-activity-warning')).toHaveTextContent('Raw local output may contain secrets.');
    const disclosure = screen.getByTestId('planning-turn-activity');
    expect(disclosure).not.toHaveAttribute('open');
    expect(disclosure).toHaveTextContent('running');

    fireEvent.click(within(disclosure).getByText(/Activity/));
    expect(screen.getByText(exactText(stdout))).toBeVisible();
    expect(screen.getByText(exactText(stderr))).toBeVisible();
    expect(screen.getByText(exactText(reasoning))).toBeVisible();
    expect(disclosure).toHaveTextContent('stdout');
    expect(disclosure).toHaveTextContent('stderr');
    expect(disclosure).toHaveTextContent('provider-exposed reasoning');

    await act(async () => {
      resolveSend?.({
        ok: true,
        sessionId: 'session-1',
        reply: 'Final answer.',
        draftPlanAvailable: false,
      });
    });
    await waitFor(() => expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Final answer.'));
  });

  it('restores activity after reload with independent collapsed panels and truncation metadata', async () => {
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'saved-planning-1',
          title: 'Saved planning chat',
          status: 'still_discussing',
          draftPlanAvailable: false,
          activity: [
            restoredActivity({
              turnId: 'turn-one',
              retainedBytes: 24,
              droppedBytes: 7,
              truncated: true,
            }),
            restoredActivity({
              turnId: 'turn-two',
              userMessageId: 1,
              assistantMessageId: 2,
              retainedBytes: 18,
              events: [
                {
                  sequence: 1,
                  source: 'stderr',
                  text: 'second panel exact',
                  byteCount: 18,
                  createdAt: '2026-07-07T00:00:01.300Z',
                },
              ],
            }),
          ],
        }),
      ],
    })) as any;

    render(<App />);
    await openPlanningTerminal();
    await waitFor(() => expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Draft plan ready.'));
    fireEvent.click(screen.getByRole('button', { name: 'Verbose' }));

    const disclosures = screen.getAllByTestId('planning-turn-activity');
    expect(disclosures).toHaveLength(2);
    expect(disclosures[0]).not.toHaveAttribute('open');
    expect(disclosures[1]).not.toHaveAttribute('open');

    fireEvent.click(within(disclosures[0]).getByText(/Activity/));
    expect(disclosures[0]).toHaveAttribute('open');
    expect(disclosures[1]).not.toHaveAttribute('open');
    expect(screen.getByTestId('planning-turn-activity-truncated')).toHaveTextContent('7 dropped');
    expect(screen.getByText(exactText('restored stdout\n  exact\n'))).toBeVisible();
  });

  it('keeps failed activity attached after the originating user message', async () => {
    mock.api.planningChatSend = vi.fn(async () => ({
      ok: false,
      sessionId: 'session-1',
      error: 'planner failed',
    })) as any;

    render(<App />);
    await openPlanningTerminal();
    submitPlanningText('fail with output');
    await waitFor(() => expect(mock.api.planningChatSend).toHaveBeenCalledTimes(1));
    const turnId = sentTurnId(mock);

    await act(async () => {
      mock.firePlanningChatStream({ sessionId: 'session-1', turnId, source: 'stderr', sequence: 1, chunk: 'failure raw\n' });
    });
    await waitFor(() => expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('planner failed'));

    fireEvent.click(screen.getByRole('button', { name: 'Verbose' }));
    const disclosure = screen.getByTestId('planning-turn-activity');
    expect(disclosure).toHaveTextContent('failed');
    fireEvent.click(within(disclosure).getByText(/Activity/));
    expect(screen.getByText(exactText('failure raw\n'))).toBeVisible();
  });

  it('keeps interleaved and late chunks owned by their turn across session switches', async () => {
    mock.api.planningChatSend = vi.fn(() => new Promise(() => {}) as any) as any;

    render(<App />);
    await openPlanningTerminal();
    submitPlanningText('first request');
    await waitFor(() => expect(mock.api.planningChatSend).toHaveBeenCalledTimes(1));
    const firstTurnId = sentTurnId(mock, 0);

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    submitPlanningText('second request');
    await waitFor(() => expect(mock.api.planningChatSend).toHaveBeenCalledTimes(2));
    const secondTurnId = sentTurnId(mock, 1);

    await act(async () => {
      mock.firePlanningChatStream({ sessionId: 'session-2', turnId: secondTurnId, source: 'stdout', sequence: 1, chunk: 'second-owned\n' });
      mock.firePlanningChatStream({ sessionId: 'session-1', turnId: firstTurnId, source: 'stdout', sequence: 1, chunk: 'first-late\n' });
      mock.firePlanningChatStream({ sessionId: 'session-2', turnId: 'unknown-turn', source: 'stdout', sequence: 2, chunk: 'unknown-turn\n' });
      mock.firePlanningChatStream({ sessionId: 'session-2', chunk: 'missing turn id\n' });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Verbose' }));
    let disclosure = screen.getByTestId('planning-turn-activity');
    fireEvent.click(within(disclosure).getByText(/Activity/));
    expect(screen.getByText(exactText('second-owned\n'))).toBeVisible();
    expect(screen.queryByText('first-late')).not.toBeInTheDocument();
    expect(screen.queryByText('missing turn id')).not.toBeInTheDocument();

    fireEvent.click(within(screen.getByTestId('planning-session-list')).getByRole('button', { name: /first request/i }));
    disclosure = await screen.findByTestId('planning-turn-activity');
    fireEvent.click(within(disclosure).getByText(/Activity/));
    expect(screen.getByText(exactText('first-late\n'))).toBeVisible();
    expect(screen.queryByText('unknown-turn')).not.toBeInTheDocument();
    expect(screen.queryByText('second-owned')).not.toBeInTheDocument();
  });
});
