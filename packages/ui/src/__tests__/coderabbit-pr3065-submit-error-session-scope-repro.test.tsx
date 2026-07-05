import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { InAppPlanningChatResponse, InAppPlanningSubmitResponse } from '@invoker/contracts';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  // Dynamic import is required because Vitest hoists mock factories before test imports.
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

// Dynamic import is required so App sees the hoisted @xyflow/react mock.
const { App } = await import('../App.js');

// CodeRabbit PR #3065 (discussion r3524140230): the submit error lived on the App
// component, not the planning session, so a submit failure in one chat leaked into
// whatever chat happened to be active afterwards.
//
// This repro drafts a plan in two chats, fails the submit in chat #1, then switches
// to chat #2 (which has its own ready draft and never failed a submit). Switching
// sessions must not carry chat #1's error into chat #2.
//   - Buggy (App-level) code renders the leaked panel in chat #2 -> repro exits non-zero.
//   - Fixed (per-session) code keeps the error on chat #1 only -> repro exits zero.
describe('CodeRabbit PR #3065 — submit error is scoped to its planning session', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  function switchToChat(title: string): void {
    const rail = screen.getByTestId('planning-session-rail');
    const entry = within(rail).getByText(title).closest('button');
    if (!entry) throw new Error(`No planning session entry titled "${title}"`);
    fireEvent.click(entry);
  }

  it('does not leak one chat\'s submit error into another chat on switch', async () => {
    const sendReplies: InAppPlanningChatResponse[] = [
      {
        ok: true,
        sessionId: 'session-1',
        reply: 'Plan A is ready.',
        draftPlanAvailable: true,
        draftPlanSummary: { name: 'Plan A', taskCount: 2, steps: ['First', 'Second'] },
      },
      {
        ok: true,
        sessionId: 'session-2',
        reply: 'Plan B is ready.',
        draftPlanAvailable: true,
        draftPlanSummary: { name: 'Plan B', taskCount: 2, steps: ['Third', 'Fourth'] },
      },
    ];
    let sendIndex = 0;
    mock.api.planningChatSend = vi.fn(
      async (): Promise<InAppPlanningChatResponse> =>
        sendReplies[Math.min(sendIndex++, sendReplies.length - 1)],
    );
    mock.api.planningChatSubmit = vi.fn(
      async (): Promise<InAppPlanningSubmitResponse> => ({ ok: false, error: 'Chat A submit failed.' }),
    );

    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-planning'));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });

    // Chat #1: draft plan A.
    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: 'draft plan A' } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
    await screen.findByTestId('invoker-terminal-ready-bar');

    // Chat #2: open a fresh chat and draft plan B.
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: 'draft plan B' } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-ready-bar')).toHaveTextContent('Plan B');
    });

    // Back to chat #1 and fail its submit, which opens the error panel here.
    switchToChat('draft plan A');
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-ready-bar')).toHaveTextContent('Plan A');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit to Invoker' }));
    await screen.findByTestId('invoker-terminal-submit-error');

    // Switch to chat #2. It has a ready draft but never failed a submit.
    switchToChat('draft plan B');
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-ready-bar')).toHaveTextContent('Plan B');
    });

    // The error belongs to chat #1 only; chat #2 must show no submit-error panel.
    expect(screen.queryByTestId('invoker-terminal-submit-error')).not.toBeInTheDocument();
  });
});
