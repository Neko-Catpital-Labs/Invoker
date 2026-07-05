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

const CLIPBOARD_REJECTION = 'clipboard-denied-pr3065';

function flush(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

// CodeRabbit PR #3065 (discussion r3524140238): the "Copy error" button did
// `void navigator.clipboard?.writeText(...)`. writeText can reject (e.g. denied
// permission); voiding it attaches no rejection handler, so the failure surfaces
// as an unhandled promise rejection. App.tsx's handleCopyWorkflowId already guards
// with `.catch(() => {})`.
//   - Buggy code leaves the rejection unhandled -> the listener records it -> repro exits non-zero.
//   - Fixed code catches it -> nothing recorded -> repro exits zero.
describe('CodeRabbit PR #3065 — Copy error handles clipboard rejection', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
    delete (globalThis.navigator as { clipboard?: unknown }).clipboard;
  });

  it('does not emit an unhandled rejection when the clipboard write is denied', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      Object.defineProperty(globalThis.navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error(CLIPBOARD_REJECTION)) },
      });

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

      fireEvent.click(screen.getByRole('button', { name: 'Copy error' }));

      // Give Node a chance to report an unhandled rejection for the voided promise.
      await flush(100);

      const leaked = unhandled.filter(
        (reason) => reason instanceof Error && reason.message === CLIPBOARD_REJECTION,
      );
      expect(leaked).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
