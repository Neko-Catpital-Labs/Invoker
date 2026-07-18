/**
 * Component test: Plan loading and DAG rendering.
 *
 * Demoted from packages/app/e2e/plan-loading.spec.ts.
 * Tests that loading tasks renders nodes in the DAG mock.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { vi } from 'vitest';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

const alpha = makeUITask({
  id: 'task-alpha',
  description: 'First test task',
  status: 'pending',
  workflowId: 'wf-load',
  command: 'echo hello-alpha',
});

const beta = makeUITask({
  id: 'task-beta',
  description: 'Second test task depending on alpha',
  status: 'pending',
  workflowId: 'wf-load',
  dependencies: ['task-alpha'],
  command: 'echo hello-beta',
});
const workflows: WorkflowMeta[] = [
  { id: 'wf-load', name: 'Loaded Workflow', status: 'running' },
];
function makeTypingLagScenario(sessionCount: number, messagesPerSession: number) {
  const tasks = Array.from({ length: sessionCount }, (_, sessionIndex) => {
    const id = `task-${String(sessionIndex).padStart(2, '0')}`;
    const prompt = Array.from({ length: messagesPerSession }, (_message, messageIndex) => (
      `session-${sessionIndex} message-${messageIndex}: deterministic planning transcript payload`
    )).join('\n');

    return makeUITask({
      id,
      description: `Typing lag scenario task ${sessionIndex}`,
      status: 'pending',
      workflowId: 'wf-typing',
      dependencies: sessionIndex === 0 ? [] : [`task-${String(sessionIndex - 1).padStart(2, '0')}`],
      prompt,
      execution: {
        agentSessionId: `session-${String(sessionIndex).padStart(2, '0')}`,
      },
    });
  });

  return {
    tasks,
    workflows: [{ id: 'wf-typing', name: 'Typing Baseline Workflow', status: 'running' }] as WorkflowMeta[],
  };
}

describe('Plan loading (component)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('renders workflow graph nodes after setTasks', async () => {
    render(<App />);
    act(() => mock.setTasks([alpha, beta], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-load')).toBeInTheDocument();
    });
  });

  it('tasks are in pending state', () => {
    expect(alpha.status).toBe('pending');
    expect(beta.status).toBe('pending');
  });

  it('empty state disappears after tasks are loaded', async () => {
    render(<App />);
    expect(screen.getByTestId('workflow-graph-surface')).toHaveTextContent('Your plan will appear here.');

    act(() => mock.setTasks([alpha, beta], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-graph-surface')).not.toHaveTextContent('Your plan will appear here.');
    });
  });

  it('selecting workflow renders mini DAG for its tasks', async () => {
    render(<App />);
    act(() => mock.setTasks([alpha, beta], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-load')).toBeInTheDocument();
    });
    screen.getByTestId('workflow-node-wf-load').click();
    await waitFor(() => expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Loaded Workflow task DAG'));
  });
  it('reports a deterministic many-session planning typing lag baseline', async () => {
    const sessionCount = 12;
    const messagesPerSession = 16;
    const scenario = makeTypingLagScenario(sessionCount, messagesPerSession);
    render(<App />);
    act(() => mock.setTasks(scenario.tasks, scenario.workflows));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-typing')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('workflow-node-wf-typing'));

    await waitFor(() => {
      expect(screen.getByTestId('rf__node-task-00')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('rf__node-task-00'));

    await waitFor(() => {
      expect(screen.getByTestId('prompt-command-display')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('prompt-command-display'));

    await waitFor(() => {
      expect(screen.getByTestId('edit-prompt-input')).toBeInTheDocument();
    });
    const editPromptInput = screen.getByTestId('edit-prompt-input');
    const nextPrompt = `${scenario.tasks[0].config.prompt}\noperator typed follow-up`;
    fireEvent.change(editPromptInput, { target: { value: nextPrompt } });

    await waitFor(() => {
      expect(vi.mocked(mock.api.reportUiPerf).mock.calls.some(([metric]) => metric === 'planning_typing_lag_baseline')).toBe(true);
    });

    const perfCall = vi.mocked(mock.api.reportUiPerf).mock.calls.find(
      ([metric]) => metric === 'planning_typing_lag_baseline',
    );
    expect(perfCall?.[1]).toEqual(expect.objectContaining({
      scenario: 'many-chats-many-messages-typing',
      sessionCount,
      transcriptMessageCount: sessionCount * messagesPerSession,
      taskCount: sessionCount,
      workflowCount: 1,
      activeSurface: 'planning',
      activeState: 'dag:task_selected:terminal-minimized',
      viewMode: 'dag',
      terminalDrawerState: 'minimized',
      selectionState: 'task_selected',
      selectedTaskId: 'task-00',
      selectedWorkflowId: 'wf-typing',
      targetName: 'edit-prompt-input',
      targetTagName: 'textarea',
      targetValueLength: nextPrompt.length,
      targetReadOnly: false,
      targetDisabled: false,
      targetIsComposing: false,
      eventType: 'change',
      lagMs: expect.any(Number),
    }));
    expect((perfCall?.[1] as Record<string, unknown>).transcriptSizeBytes).toBeGreaterThan(10_000);
  });
});
