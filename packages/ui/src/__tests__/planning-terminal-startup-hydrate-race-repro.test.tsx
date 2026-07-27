import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PlanningPresetOption } from '@invoker/contracts';
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

  it.fails('keeps the restored chat preset when preset options resolve after planning chat hydrate', async () => {
    let resolvePresets: ((value: PlanningPresetOption[]) => void) | null = null;
    mock.api.getPlanningPresets = vi.fn(() => new Promise<PlanningPresetOption[]>((resolve) => {
      resolvePresets = resolve;
    })) as any;
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'saved-omp-chat',
          title: 'Saved OMP chat',
          status: 'still_discussing',
          presetKey: 'omp+claude',
          draftPlanAvailable: false,
          messages: [
            {
              id: 1,
              role: 'user',
              text: 'Restore me before presets finish loading',
              createdAt: '2026-07-07T00:00:01.000Z',
            },
            {
              id: 2,
              role: 'assistant',
              text: 'Restored OMP transcript.',
              createdAt: '2026-07-07T00:00:02.000Z',
            },
          ],
        }),
      ],
    }));

    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-home'));
    const expandPlanningChats = screen.queryByRole('button', { name: 'Expand planning chats' });
    if (expandPlanningChats) fireEvent.click(expandPlanningChats);

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Restored OMP transcript.');
    });

    await act(async () => {
      resolvePresets?.([
        { key: 'codex', label: 'Codex', tool: 'codex', isDefault: true },
        { key: 'omp+claude', label: 'Claude via OMP', tool: 'omp', model: 'claude', isDefault: false },
      ]);
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Options' }));

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('omp+claude');
    });
  });
});
