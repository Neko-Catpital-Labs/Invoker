import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

function makeGroupedDraft() {
  return makePlanningSessionSummary({
    id: 'draft-1',
    title: 'Grouped draft',
    status: 'draft_ready',
    draftPlanAvailable: true,
    draftPlanSummary: {
      name: 'Grouped plan',
      taskCount: 3,
      workflowCount: 2,
      steps: ['Backend workflow', 'Frontend workflow'],
      taskGroups: [
        { name: 'Backend workflow', taskCount: 1, steps: ['Add API endpoint'] },
        { name: 'Frontend workflow', taskCount: 2, steps: ['Add review sidebar', 'Wire ready bar actions'] },
      ],
    },
    draftPlanText: [
      'name: Grouped plan',
      'workflows:',
      '  - name: Backend workflow',
      '    tasks:',
      '      - id: api',
      '        description: Add API endpoint',
      '',
    ].join('\n'),
  });
}

describe('planning draft review', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('opens draft review in the right context panel without submitting', async () => {
    vi.mocked(mock.api.planningChatList).mockResolvedValue({ ok: true, sessions: [makeGroupedDraft()] });

    render(<App />);

    expect(await screen.findByTestId('terminal-ready-bar')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ready-bar-review-draft'));

    expect(await screen.findByRole('heading', { name: 'Review draft' })).toBeInTheDocument();
    expect(mock.api.planningChatSubmit).not.toHaveBeenCalled();
    expect(mock.api.start).not.toHaveBeenCalled();
    expect(screen.queryByText('No actions recorded')).not.toBeInTheDocument();
    expect(screen.getByText('Backend workflow')).toBeInTheDocument();
    expect(screen.getAllByTestId('draft-task-group')).toHaveLength(2);
    expect(screen.getAllByTestId('draft-step-summary')).toHaveLength(3);
    expect(screen.getByText('Add API endpoint')).toBeInTheDocument();
    expect(screen.getByText('Add review sidebar')).toBeInTheDocument();
    expect(screen.getByText('Wire ready bar actions')).toBeInTheDocument();
    expect(screen.getByTestId('draft-raw-yaml')).toHaveTextContent('name: Grouped plan');
    expect(screen.getByTestId('draft-raw-yaml')).toHaveTextContent('description: Add API endpoint');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('planning-context-panel')));
  });

  it('submits only from an explicit draft review action', async () => {
    vi.mocked(mock.api.planningChatList).mockResolvedValue({ ok: true, sessions: [makeGroupedDraft()] });
    vi.mocked(mock.api.planningChatSubmit).mockResolvedValue({
      ok: true,
      planName: 'Grouped plan',
      workflowId: 'wf-created',
    });

    render(<App />);

    expect(await screen.findByTestId('terminal-ready-bar')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ready-bar-review-draft'));
    expect(await screen.findByRole('heading', { name: 'Review draft' })).toBeInTheDocument();
    expect(mock.api.planningChatSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('draft-review-create-workflow'));

    await waitFor(() => {
      expect(mock.api.planningChatSubmit).toHaveBeenCalledWith({ sessionId: 'draft-1' });
    });
  });

  it('keeps Open graph as explicit secondary navigation', async () => {
    vi.mocked(mock.api.planningChatList).mockResolvedValue({ ok: true, sessions: [makeGroupedDraft()] });

    render(<App />);

    expect(await screen.findByTestId('terminal-ready-bar')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ready-bar-open-graph'));

    expect(await screen.findByText('No actions recorded')).toBeInTheDocument();
    expect(screen.queryByText('Review draft')).not.toBeInTheDocument();
  });

  it('creates a workflow from the ready bar and clears draft readiness locally', async () => {
    vi.mocked(mock.api.planningChatList).mockResolvedValue({ ok: true, sessions: [makeGroupedDraft()] });
    vi.mocked(mock.api.planningChatSubmit).mockResolvedValue({
      ok: true,
      planName: 'Grouped plan',
      workflowId: 'wf-created',
    });

    render(<App />);

    expect(await screen.findByTestId('terminal-ready-bar')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ready-bar-create-workflow'));

    await waitFor(() => {
      expect(mock.api.planningChatSubmit).toHaveBeenCalledWith({ sessionId: 'draft-1' });
    });
    await waitFor(() => {
      expect(screen.queryByTestId('terminal-ready-bar')).not.toBeInTheDocument();
    });
  });
});
