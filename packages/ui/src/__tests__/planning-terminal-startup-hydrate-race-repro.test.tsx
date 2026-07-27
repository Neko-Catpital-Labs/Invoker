import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { InAppPlanningListSessionsResponse } from '@invoker/contracts';
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
    dispose(): void {}
    write(): void {}
    refresh(): void {}
    focus(): void {}
    onData(): { dispose: () => void } {
      return { dispose() {} };
    }
  },
}));

vi.mock('xterm-addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  },
}));

const { App } = await import('../App.js');

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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

describe('planning terminal startup hydrate race repro', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  // Desired behavior: a late startup restore must not replace an active local
  // planning turn that already received its real server session id.
  it.fails('keeps the active first turn when delayed startup hydrate returns saved sessions', async () => {
    const listCalls: Array<Deferred<InAppPlanningListSessionsResponse>> = [];
    mock.api.planningChatList = vi.fn(() => {
      const call = deferred<InAppPlanningListSessionsResponse>();
      listCalls.push(call);
      return call.promise;
    }) as any;
    mock.api.planningChatSend = vi.fn(async () => ({
      ok: true,
      sessionId: 'fresh-session',
      reply: 'Fresh reply after late hydrate.',
      draftPlanAvailable: false,
    })) as any;

    render(<App />);
    await waitFor(() => expect(mock.api.planningChatList).toHaveBeenCalledTimes(2));
    await openPlanningTerminal();

    submitPlanningText('draft the fresh plan');
    await screen.findByText('Fresh reply after late hydrate.');

    const staleRestore: InAppPlanningListSessionsResponse = {
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'stale-restored-session',
          title: 'Stale restored plan',
          messages: [
            {
              id: 1,
              role: 'assistant',
              text: 'Stale restored answer from startup hydrate.',
              createdAt: '2026-07-07T00:00:01.000Z',
            },
          ],
          draftPlanAvailable: false,
          draftPlanSummary: undefined,
          draftPlanText: undefined,
        }),
      ],
    };

    await act(async () => {
      for (const call of listCalls) call.resolve(staleRestore);
      await Promise.resolve();
      await Promise.resolve();
    });

    const transcript = screen.getByTestId('invoker-terminal-transcript');
    expect(transcript).toHaveTextContent('Fresh reply after late hydrate.');
    expect(transcript).not.toHaveTextContent('Stale restored answer from startup hydrate.');
  });
});
