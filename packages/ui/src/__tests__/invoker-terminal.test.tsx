import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { TaskState, WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

function makePlanningTypingFixture(
  sessionCount = 8,
  messagesPerSession = 12,
): { tasks: TaskState[]; workflows: WorkflowMeta[] } {
  const tasks: TaskState[] = [];
  const workflows: WorkflowMeta[] = [];

  for (let sessionIndex = 0; sessionIndex < sessionCount; sessionIndex += 1) {
    const workflowId = `wf-chat-${sessionIndex}`;
    workflows.push({
      id: workflowId,
      name: `Planning Chat ${sessionIndex}`,
      status: 'running',
    });

    for (let messageIndex = 0; messageIndex < messagesPerSession; messageIndex += 1) {
      const messageId = `message-${String(messageIndex).padStart(2, '0')}`;
      const previousMessageId = `message-${String(messageIndex - 1).padStart(2, '0')}`;
      tasks.push(makeUITask({
        id: `${workflowId}/${messageId}`,
        description: `Planning transcript message ${sessionIndex}.${messageIndex}`,
        status: 'pending',
        workflowId,
        dependencies: messageIndex === 0 ? [] : [`${workflowId}/${previousMessageId}`],
        prompt: [
          `session=${sessionIndex}`,
          `message=${messageIndex}`,
          `content=${'planning-context '.repeat(6)}${sessionIndex}-${messageIndex}`,
        ].join('\n'),
        execution: {
          agentSessionId: `session-${sessionIndex}`,
        },
      }));
    }
  }

  return { tasks, workflows };
}

function expectedTranscriptSize(tasks: TaskState[]): number {
  return tasks.reduce((total, task) => (
    total +
    task.description.length +
    (task.config.prompt?.length ?? 0)
  ), 0);
}

function expectedTranscriptLineCount(tasks: TaskState[]): number {
  return tasks.reduce((total, task) => (
    total +
    1 +
    (task.config.prompt ? task.config.prompt.split('\n').length : 0)
  ), 0);
}

describe('Invoker terminal planning typing telemetry (component)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mock.cleanup();
  });

  it('reports a deterministic many-chats/many-messages planning typing baseline', async () => {
    const { tasks, workflows } = makePlanningTypingFixture();
    render(<App />);

    act(() => mock.setTasks(tasks, workflows));

    await waitFor(() => {
      expect(screen.getByTestId('rf__node-wf-chat-0')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('rf__node-wf-chat-0'));

    await waitFor(() => {
      expect(screen.getByTestId('rf__node-wf-chat-0/message-00')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('rf__node-wf-chat-0/message-00'));

    await waitFor(() => {
      expect(screen.getByTestId('command-display')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('command-display'));
    const promptInput = await screen.findByTestId('edit-prompt-input') as HTMLTextAreaElement;

    const reportUiPerf = vi.mocked(mock.api.reportUiPerf);
    reportUiPerf.mockClear();

    let nowMs = 5_000;
    const performanceNowSpy = vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    const requestAnimationFrameSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      nowMs += 18;
      callback(nowMs);
      return 1;
    });

    fireEvent.input(promptInput, {
      target: { value: `${promptInput.value} typed` },
    });

    await waitFor(() => {
      expect(reportUiPerf).toHaveBeenCalledWith('planning_typing_lag', expect.any(Object));
    });

    performanceNowSpy.mockRestore();
    requestAnimationFrameSpy.mockRestore();

    const planningCalls = reportUiPerf.mock.calls.filter(([metric]) => metric === 'planning_typing_lag');
    expect(planningCalls).toHaveLength(1);
    expect(planningCalls[0][1]).toEqual(expect.objectContaining({
      durationMs: 18,
      taskCount: tasks.length,
      workflowCount: workflows.length,
      sessionCount: workflows.length,
      transcriptSizeChars: expectedTranscriptSize(tasks),
      transcriptLineCount: expectedTranscriptLineCount(tasks),
      transcriptMessageCount: tasks.length * 2,
      selectedWorkflowTaskCount: 12,
      activeSurface: 'workflow_task_dag',
      activeState: 'pending',
      activeNodeKind: 'task',
      terminalState: 'collapsed',
      inspectorState: 'expanded',
      statusFilterCount: 0,
      eventType: 'input',
      inputType: 'unknown',
      targetKind: 'textarea',
      targetValueLength: promptInput.value.length,
      readOnly: false,
      isComposing: false,
    }));
  });

  it('does not report read-only or composing input events', async () => {
    render(<App />);
    await waitFor(() => {
      expect(mock.api.getTasks).toHaveBeenCalled();
    });

    const reportUiPerf = vi.mocked(mock.api.reportUiPerf);
    reportUiPerf.mockClear();

    const readOnlyInput = document.createElement('textarea');
    readOnlyInput.readOnly = true;
    document.body.appendChild(readOnlyInput);
    fireEvent.input(readOnlyInput, { target: { value: 'read only' } });

    const composingInput = document.createElement('textarea');
    document.body.appendChild(composingInput);
    const composingEvent = new Event('input', { bubbles: true });
    Object.defineProperty(composingEvent, 'isComposing', { value: true });
    composingInput.value = 'composing';
    fireEvent(composingInput, composingEvent);

    expect(reportUiPerf.mock.calls.filter(([metric]) => metric === 'planning_typing_lag')).toHaveLength(0);

    readOnlyInput.remove();
    composingInput.remove();
  });
});
