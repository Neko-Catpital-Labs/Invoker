import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

describe('planning pre-turn failure ref sync repro', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  async function openPlanningSurface() {
    fireEvent.click(await screen.findByTestId('sidebar-home'));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-input')).toBeInTheDocument();
    });
  }

  // Regression proof for the swap in the pre-turn-failure-without-turnId
  // branch of handlePlanningSendResult: planningSessionsRef must carry the
  // swapped backend session id synchronously, in the same microtask as the
  // response. removePlanningSessionsById (Delete button) rebuilds the whole
  // session list straight from that ref, and can run for an unrelated chat
  // before the render effect that would otherwise catch the ref up — if the
  // ref is still stale, it silently reverts our session back to its
  // pre-failure local id.
  it('keeps the backend-swapped session id after deleting an unrelated chat in the same tick as the failure', async () => {
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'decoy-chat',
          title: 'Decoy chat',
          status: 'still_discussing',
          draftPlanAvailable: false,
          draftPlanSummary: undefined,
          draftPlanText: undefined,
          messages: [
            { id: 1, role: 'user', text: 'Unrelated', createdAt: '2026-07-07T00:00:01.000Z' },
          ],
        }),
      ],
    }));

    let resolveSend: (() => void) | undefined;
    mock.api.planningChatSend = vi.fn(() => new Promise((resolve) => {
      resolveSend = () => resolve({
        ok: false,
        sessionId: 'server-2',
        error: 'planner exited before producing a reply',
      });
    })) as typeof mock.api.planningChatSend;

    render(<App />);
    await openPlanningSurface();

    fireEvent.click(await screen.findByRole('button', { name: 'New chat' }));

    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: 'hello planner' } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledTimes(1);
    });

    const decoyRow = screen.getByText('Decoy chat').closest('[data-testid="planning-session-row"]') as HTMLElement;
    const decoyDeleteButton = within(decoyRow).getByRole('button', { name: 'Delete planning chat' });

    // Resolve the failure, then delete the unrelated chat before React's
    // ref-sync effect (deferred to a render commit) has a chance to run.
    // Both the promise continuation and the delete handler read the refs
    // synchronously, so this only needs to stay within microtask land (no
    // timers, no waitFor, no macrotask boundary).
    await act(async () => {
      resolveSend?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      fireEvent.click(decoyDeleteButton);
    });

    await waitFor(() => {
      expect(screen.queryByText('Decoy chat')).not.toBeInTheDocument();
    });

    // Only one chat remains now: our target. If the ref was stale when the
    // decoy delete ran, removePlanningSessionsById would have rebuilt state
    // from that stale snapshot and reverted our session back to its
    // pre-failure 'local-' id, discarding the swap.
    const remainingDeleteButton = screen.getByRole('button', { name: 'Delete planning chat' });
    fireEvent.click(remainingDeleteButton);

    await waitFor(() => {
      expect(mock.api.planningChatDelete).toHaveBeenCalledTimes(2);
    });
    // handleDeletePlanningSession only calls planningChatDelete for a
    // non-'local-' id, so a reverted id would leave this call out entirely
    // (or send the stale pre-failure id instead).
    expect(mock.api.planningChatDelete).toHaveBeenCalledWith({ sessionId: 'server-2' });
  });
});
