import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';
import type { DraftPlanSummary, PlanningChatSendResponse } from '../components/InvokerTerminal.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

function addPlanningChatMock(mock: MockInvoker) {
  const sendPlanningChatMessage = vi.fn<(message: string) => Promise<PlanningChatSendResponse>>();
  (mock.api as typeof mock.api & { sendPlanningChatMessage: typeof sendPlanningChatMessage })
    .sendPlanningChatMessage = sendPlanningChatMessage;
  return sendPlanningChatMessage;
}

function expandTerminal() {
  fireEvent.click(screen.getByLabelText('Expand terminal drawer'));
  return screen.getByTestId('invoker-terminal-input');
}

describe('InvokerTerminal planning ready bar', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('refreshes the ready bar and task list after a second planner reply in the same session', async () => {
    const sendPlanningChatMessage = addPlanningChatMock(mock);
    const firstSummary: DraftPlanSummary = {
      planName: 'First Planner Draft',
      taskCount: 2,
      taskGroups: [
        {
          name: 'First group',
          tasks: [
            { id: 'first-a', description: 'Install dependencies' },
            { id: 'first-b', description: 'Wire first screen' },
          ],
        },
      ],
    };
    const secondSummary: DraftPlanSummary = {
      planName: 'Second Planner Draft',
      taskCount: 3,
      taskGroups: [
        {
          name: 'Backend updates',
          tasks: [
            { id: 'second-api', description: 'Add planner API route' },
            { id: 'second-store', description: 'Persist latest draft metadata' },
          ],
        },
        {
          name: 'UI refresh',
          tasks: [
            { id: 'second-ui', description: 'Refresh ready bar from latest summary' },
          ],
        },
      ],
    };

    sendPlanningChatMessage
      .mockResolvedValueOnce({ reply: 'First draft is ready.', draftPlanSummary: firstSummary })
      .mockResolvedValueOnce({ reply: 'Second draft is ready.', draftPlanSummary: secondSummary });

    render(<App />);
    const input = expandTerminal();

    fireEvent.change(input, { target: { value: 'Draft a first plan' } });
    fireEvent.click(screen.getByTestId('invoker-terminal-send'));

    expect(await screen.findByTestId('invoker-terminal-ready-bar')).toHaveTextContent('First Planner Draft');
    expect(screen.getByTestId('invoker-terminal-ready-task-count')).toHaveTextContent('2 tasks');
    expect(screen.getByTestId('invoker-terminal-ready-task-list')).toHaveTextContent('Install dependencies');
    expect(screen.getByTestId('invoker-terminal-ready-task-list')).toHaveTextContent('First group');

    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: 'Revise that plan' } });
    fireEvent.click(screen.getByTestId('invoker-terminal-send'));

    await waitFor(() => {
      expect(sendPlanningChatMessage).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('invoker-terminal-ready-plan-name')).toHaveTextContent('Second Planner Draft');
    });

    const readyBar = screen.getByTestId('invoker-terminal-ready-bar');
    const taskList = screen.getByTestId('invoker-terminal-ready-task-list');
    expect(readyBar).toHaveTextContent('3 tasks');
    expect(taskList).toHaveTextContent('Backend updates');
    expect(taskList).toHaveTextContent('UI refresh');
    expect(taskList).toHaveTextContent('Add planner API route');
    expect(taskList).toHaveTextContent('Refresh ready bar from latest summary');
    expect(readyBar).not.toHaveTextContent('First Planner Draft');
    expect(taskList).not.toHaveTextContent('Install dependencies');
    expect(taskList).not.toHaveTextContent('First group');
  });

  it('submits the current draft through planning chat and clears the ready bar after load', async () => {
    const sendPlanningChatMessage = addPlanningChatMock(mock);
    const summary: DraftPlanSummary = {
      planName: 'Submittable Draft',
      taskCount: 1,
      taskGroups: [{ name: 'Submit group', tasks: [{ id: 'submit-task', description: 'Run submitted work' }] }],
    };
    const submittedPlanText = [
      'name: Submitted Draft',
      'tasks:',
      '  - id: submitted-task',
      '    description: Run submitted work',
      '    command: echo submitted',
    ].join('\n');

    sendPlanningChatMessage
      .mockResolvedValueOnce({ reply: 'Draft ready.', draftPlanSummary: summary })
      .mockResolvedValueOnce({
        reply: 'Plan "Submitted Draft" submitted for execution.',
        planSubmitted: true,
        submittedPlanText,
      });

    render(<App />);
    const input = expandTerminal();

    fireEvent.change(input, { target: { value: 'Draft a submittable plan' } });
    fireEvent.click(screen.getByTestId('invoker-terminal-send'));

    expect(await screen.findByTestId('invoker-terminal-ready-bar')).toHaveTextContent('Submittable Draft');

    fireEvent.click(screen.getByTestId('invoker-terminal-submit-plan'));

    await waitFor(() => {
      expect(sendPlanningChatMessage).toHaveBeenLastCalledWith('yes');
      expect(mock.api.loadPlan).toHaveBeenCalledWith(submittedPlanText);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('invoker-terminal-ready-bar')).not.toBeInTheDocument();
    });
  });

  it('clears the ready summary without sending another planner message', async () => {
    const sendPlanningChatMessage = addPlanningChatMock(mock);
    sendPlanningChatMessage.mockResolvedValueOnce({
      reply: 'Draft ready.',
      draftPlanSummary: {
        planName: 'Clearable Draft',
        taskCount: 1,
        taskGroups: [{ name: 'Clear group', tasks: [{ id: 'clear-task', description: 'Clear this task' }] }],
      },
    });

    render(<App />);
    const input = expandTerminal();

    fireEvent.change(input, { target: { value: 'Draft a clearable plan' } });
    fireEvent.click(screen.getByTestId('invoker-terminal-send'));

    expect(await screen.findByTestId('invoker-terminal-ready-bar')).toHaveTextContent('Clearable Draft');

    fireEvent.click(screen.getByTestId('invoker-terminal-clear-plan'));

    expect(screen.queryByTestId('invoker-terminal-ready-bar')).not.toBeInTheDocument();
    expect(sendPlanningChatMessage).toHaveBeenCalledTimes(1);
  });
});
