import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { InAppPlanningChatResponse } from '@invoker/contracts';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  // Dynamic import is required because Vitest hoists mock factories before test imports.
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

// Dynamic import is required so App sees the hoisted @xyflow/react mock.
const { App } = await import('../App.js');

// CodeRabbit PR #3065 (discussion r3524140233): the generic planningChatSend
// failure path (a plain chat message, not a draft submit) also set
// `planningSubmitError`. When a draft is already ready, that error rendered
// inside the "ready bar" submit-error panel whose "Retry submit" button calls
// onSubmitDraft — i.e. it resubmits the draft instead of retrying the chat.
//
// The submit-error panel must be reserved for draft-submit failures. A failed
// chat message should surface only in the transcript, not in the panel.
//   - Buggy code shows the submit-error panel -> assertion fails -> repro exits non-zero.
//   - Fixed code keeps the failure in the transcript only -> repro exits zero.
describe('CodeRabbit PR #3065 — chat-send failures do not open the submit-error panel', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('keeps a failed chat message out of the draft submit-error panel', async () => {
    const chatFailure = 'The planner hit a snag.';
    const sendReplies: InAppPlanningChatResponse[] = [
      {
        ok: true,
        sessionId: 'session-1',
        reply: 'Here is the plan.',
        draftPlanAvailable: true,
        draftPlanSummary: { name: 'Draft', taskCount: 2, steps: ['First', 'Second'] },
      },
      { ok: false, error: chatFailure },
    ];
    let sendIndex = 0;
    mock.api.planningChatSend = vi.fn(
      async (): Promise<InAppPlanningChatResponse> =>
        sendReplies[Math.min(sendIndex++, sendReplies.length - 1)],
    );

    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-planning'));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });

    // First message drafts a plan, so the ready bar (which hosts the submit-error panel) mounts.
    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: 'draft the full plan' } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
    await screen.findByTestId('invoker-terminal-ready-bar');

    // Second message is a regular chat send that fails.
    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: 'any follow-up question' } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent(chatFailure);
    });

    // The draft is still ready, but the chat failure must not hijack the submit-error panel.
    expect(screen.getByTestId('invoker-terminal-ready-bar')).toBeInTheDocument();
    expect(screen.queryByTestId('invoker-terminal-submit-error')).not.toBeInTheDocument();
  });
});
