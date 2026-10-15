import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');
const { PLANNING_TOOLS_EMPTY_PATH_MESSAGE } = await import('../components/InvokerTerminal.js');

describe('planning presets PATH empty state', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  async function openComposerOptions() {
    fireEvent.click(await screen.findByTestId('sidebar-home'));
    const expandPlanningChats = screen.queryByRole('button', { name: 'Expand planning chats' });
    if (expandPlanningChats) fireEvent.click(expandPlanningChats);
    if (!screen.queryByTestId('invoker-terminal-harness')) {
      fireEvent.click(await screen.findByRole('button', { name: 'Options' }));
    }
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toBeInTheDocument();
    });
  }

  it('shows empty PATH copy with invoker-cli doctor and no Codex option when presets are empty', async () => {
    mock.api.getPlanningPresets = vi.fn(async () => ({ options: [], cursorDiscovery: { status: 'skipped' } })) as typeof mock.api.getPlanningPresets;

    render(<App />);
    await openComposerOptions();

    const emptyState = await screen.findByTestId('invoker-terminal-planning-tools-empty');
    expect(emptyState).toHaveTextContent(PLANNING_TOOLS_EMPTY_PATH_MESSAGE);
    expect(emptyState).toHaveTextContent('invoker-cli doctor');

    const harness = screen.getByTestId('invoker-terminal-harness');
    expect(harness).toBeDisabled();
    expect(within(harness).queryByRole('option', { name: /codex/i })).not.toBeInTheDocument();
    expect(harness.querySelectorAll('option')).toHaveLength(0);
  });

  it('uses the same empty state when planning presets fail to load (no Codex fallback)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mock.api.getPlanningPresets = vi.fn(async () => {
      throw new Error('boom: getPlanningPresets IPC failed');
    }) as typeof mock.api.getPlanningPresets;

    try {
      render(<App />);
      await openComposerOptions();

      const emptyState = await screen.findByTestId('invoker-terminal-planning-tools-empty');
      expect(emptyState).toHaveTextContent(PLANNING_TOOLS_EMPTY_PATH_MESSAGE);
      expect(within(screen.getByTestId('invoker-terminal-harness')).queryByRole('option', { name: /codex/i }))
        .not.toBeInTheDocument();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
