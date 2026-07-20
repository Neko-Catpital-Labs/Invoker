/**
 * Component test: App launch and initial state.
 *
 * Demoted from packages/app/e2e/app-launch.spec.ts.
 * Tests UI rendering in empty state (no plan loaded).
 * Dropped: window title (Electron main process), terminal toggle (Electron shell).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

// Lazy import App after mocking @xyflow/react
const { App } = await import('../App.js');

describe('App launch (component)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('shows empty state prompt when no plan is loaded', () => {
    render(<App />);
    expect(screen.getByText('Load a plan to render workflow graph')).toBeInTheDocument();
  });

  it('renders left rail navigation and workflow controls', () => {
    render(<App />);
    expect(screen.getByTestId('rail-open-file')).toBeInTheDocument();
    expect(screen.getByTestId('rail-home')).toBeInTheDocument();
    expect(screen.getByTestId('rail-timeline')).toBeInTheDocument();
    expect(screen.getByTestId('rail-history')).toBeInTheDocument();
    expect(screen.getByTestId('rail-queue')).toBeInTheDocument();
    expect(screen.queryByTestId('rail-attention')).not.toBeInTheDocument();
    expect(screen.getByTestId('rail-refresh')).toBeInTheDocument();
    expect(screen.getByTestId('rail-clear')).toBeInTheDocument();
  });

  it('shows workflow status chips and terminal drawer controls in home view', () => {
    render(<App />);
    expect(screen.getByTestId('workflow-status-pill-running')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand terminal drawer' })).toBeInTheDocument();
  });

  it('opens system setup from left rail settings', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('rail-settings'));
    expect(await screen.findByText('System Setup')).toBeInTheDocument();
  });

  it('reviews a ready draft in the right planning panel without leaving Home', async () => {
    const session = makePlanningSessionSummary({
      draftPlanSummary: {
        name: 'Grouped plan',
        taskCount: 2,
        workflowCount: 2,
        steps: ['API workflow', 'UI workflow'],
        taskGroups: [
          { name: 'API workflow', taskCount: 1, steps: ['Implement API handoff'] },
          { name: 'UI workflow', taskCount: 1, steps: ['Render review sidebar'] },
        ],
      },
      draftPlanText: [
        'name: Grouped plan',
        'workflows:',
        '  - name: API workflow',
        '    tasks:',
        '      - id: api',
        '        description: Implement API handoff',
      ].join('\n'),
    });
    vi.mocked(mock.api.planningChatList).mockResolvedValue({ ok: true, sessions: [session] });

    render(<App />);
    fireEvent.click(await screen.findByTestId('terminal-review-draft'));

    expect(await screen.findByTestId('draft-review-panel')).toBeInTheDocument();
    expect(screen.getByTestId('rail-home')).toHaveClass('bg-gray-800');
    expect(screen.queryByTestId('action-graph-view')).not.toBeInTheDocument();
    expect(screen.getByText('Implement API handoff')).toBeInTheDocument();
    expect(screen.getByText('Render review sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('draft-raw-yaml')).toHaveTextContent('name: Grouped plan');
    await waitFor(() => expect(screen.getByTestId('planning-context-panel')).toHaveFocus());
  });

  it('clears draft readiness after creating a workflow from the ready bar', async () => {
    const session = makePlanningSessionSummary({
      id: 'draft-submit-1',
      draftPlanSummary: { name: 'Ready plan', taskCount: 1, steps: ['Create workflow'] },
      draftPlanText: 'name: Ready plan\ntasks:\n  - id: create\n    description: Create workflow\n',
    });
    vi.mocked(mock.api.planningChatList).mockResolvedValue({ ok: true, sessions: [session] });
    vi.mocked(mock.api.planningChatSubmit).mockResolvedValue({ ok: true, planName: 'Ready plan', workflowId: 'wf-created' });

    render(<App />);
    fireEvent.click(await screen.findByTestId('terminal-create-workflow'));

    await waitFor(() => expect(mock.api.planningChatSubmit).toHaveBeenCalledWith({ sessionId: 'draft-submit-1' }));
    await waitFor(() => expect(screen.queryByTestId('terminal-ready-bar')).not.toBeInTheDocument());
    expect(screen.getByText('Ready plan')).toBeInTheDocument();
  });
});
