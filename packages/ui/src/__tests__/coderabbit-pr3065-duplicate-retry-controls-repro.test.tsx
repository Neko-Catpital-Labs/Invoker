import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { InAppPlanningChatResponse, InAppPlanningSubmitResponse } from '@invoker/contracts';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  // Dynamic import is required because Vitest hoists mock factories before test imports.
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

// Dynamic import is required so App sees the hoisted @xyflow/react mock.
const { App } = await import('../App.js');

// CodeRabbit PR #3065 (discussion r3524140235): when a submit error is present the
// top action row and the error panel both rendered "Retry submit" and
// "Keep chatting" buttons with identical accessible names and identical handlers.
// Duplicate accessible names confuse assistive tech and make the intent ambiguous.
//
// The error panel must be the single source of these controls.
//   - Buggy code exposes two buttons per name -> assertion fails -> repro exits non-zero.
//   - Fixed code exposes exactly one of each -> repro exits zero.
describe('CodeRabbit PR #3065 — no duplicate submit-error controls', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('renders a single Retry submit / Keep chatting control when the error panel is shown', async () => {
    mock.api.planningChatSend = vi.fn(
      async (): Promise<InAppPlanningChatResponse> => ({
        ok: true,
        sessionId: 'session-1',
        reply: 'Here is the plan.',
        draftPlanAvailable: true,
        draftPlanSummary: { name: 'Draft', taskCount: 2, steps: ['First', 'Second'] },
      }),
    );
    mock.api.planningChatSubmit = vi.fn(
      async (): Promise<InAppPlanningSubmitResponse> => ({ ok: false, error: 'Submit failed.' }),
    );

    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-planning'));
    await screen.findByTestId('invoker-terminal-harness');

    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: 'draft the full plan' } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
    await screen.findByTestId('invoker-terminal-ready-bar');

    fireEvent.click(screen.getByRole('button', { name: 'Submit to Invoker' }));
    await screen.findByTestId('invoker-terminal-submit-error');

    // Exactly one control per action; no duplicate accessible names in the same view.
    expect(screen.getAllByRole('button', { name: 'Retry submit' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Keep chatting' })).toHaveLength(1);
  });
});
