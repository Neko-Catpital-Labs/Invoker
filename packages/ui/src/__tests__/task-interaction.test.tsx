/**
 * Component test: Task interaction — clicking nodes, TaskPanel details.
 *
 * Demoted from packages/app/e2e/task-interaction.spec.ts.
 * Dropped: terminal-related assertions (Electron shell feature).
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

const workflows: WorkflowMeta[] = [{ id: 'wf-a', name: 'Workflow A', status: 'running' }];
const failedWorkflows: WorkflowMeta[] = [{ id: 'wf-a', name: 'Workflow A', status: 'failed' }];
const alpha = makeUITask({ id: 'task-alpha', description: 'First test task', status: 'pending', workflowId: 'wf-a', command: 'echo hello-alpha' });
const beta = makeUITask({ id: 'task-beta', description: 'Second test task depending on alpha', status: 'pending', workflowId: 'wf-a', dependencies: ['task-alpha'], command: 'echo hello-beta' });

describe('Task interaction (component)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('selecting a workflow shows mini DAG and inspector content', async () => {
    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-planning'));
    act(() => mock.setTasks([alpha, beta], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-a')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('rf__node-wf-a'));

    await waitFor(() => {
      expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Workflow A');
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Workflow A');
    });
  });

  it('clicking a mini DAG task updates prompt details', async () => {
    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-planning'));
    act(() => mock.setTasks([alpha, beta], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-a')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('rf__node-wf-a'));
    await waitFor(() => {
      expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('rf__node-task-alpha'));

    await waitFor(() => {
      expect(screen.getByText('echo hello-alpha')).toBeInTheDocument();
    });
  });

  it('selecting a mini DAG task shows task sidebar state', async () => {
    const failedTask = makeUITask({
      id: 'task-failed',
      description: 'Failed task',
      status: 'failed',
      workflowId: 'wf-a',
      command: 'exit 1',
      execution: { error: 'task failed' },
    });

    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-planning'));
    act(() => mock.setTasks([failedTask], failedWorkflows));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-a')).toBeInTheDocument();
    });

    fireEvent.click(await screen.findByTestId('rf__node-task-failed'));
    await waitFor(() => {
      expect(screen.getByTestId('workflow-inspector-status-label')).toHaveTextContent('failed');
      expect(screen.getByTestId('prompt-command-display')).toHaveTextContent('exit 1');
    });
  });

  it('renders task.worker_action events in the task timeline', async () => {
    const task = makeUITask({
      id: 'task-worker-action',
      description: 'Worker action target',
      status: 'completed',
      workflowId: 'wf-a',
      command: 'pnpm test',
    });
    mock.setEvents(task.id, [{
      id: 1,
      taskId: task.id,
      eventType: 'task.worker_action',
      payload: JSON.stringify({
        workerKind: 'pr-summary-refresh',
        actionType: 'refresh-pr-summary',
        status: 'completed',
        summary: 'Updated PR body with Invoker pipeline summary',
        reviewId: '123',
      }),
      createdAt: '2026-01-01T00:00:00.000Z',
    }]);

    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-planning'));
    act(() => mock.setTasks([task], workflows));

    fireEvent.click(await screen.findByTestId('rf__node-task-worker-action'));

    await waitFor(() => {
      expect(screen.getByTestId('task-logs-section')).toHaveTextContent(
        'pr-summary-refresh/refresh-pr-summary completed: Updated PR body with Invoker pipeline summary',
      );
      expect(screen.getByTestId('task-logs-section')).toHaveTextContent('"workerKind":"pr-summary-refresh"');
    });
  });

  it('lets prompt tasks change harness and model from the inspector', async () => {
    const promptTask = makeUITask({
      id: 'task-ai',
      description: 'AI task',
      status: 'pending',
      workflowId: 'wf-a',
      prompt: 'Write a test',
      config: {
        workflowId: 'wf-a',
        prompt: 'Write a test',
        executionAgent: 'omp',
      },
    });
    vi.mocked(mock.api.getExecutionDefaults).mockResolvedValue({
      executionAgent: 'omp',
      executionModel: 'chatgpt-5.4',
    });

    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-planning'));
    act(() => mock.setTasks([promptTask], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-a')).toBeInTheDocument();
    });

    fireEvent.click(await screen.findByTestId('rf__node-task-ai'));
    await waitFor(() => {
      expect(screen.getByTestId('execution-agent-select')).toBeInTheDocument();
      expect(screen.getByTestId('execution-model-select')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('execution-agent-select'), { target: { value: 'codex' } });
    await waitFor(() => {
      expect(mock.api.editTaskAgent).toHaveBeenCalledWith('task-ai', 'codex');
    });

    fireEvent.change(screen.getByTestId('execution-model-select'), { target: { value: 'openai/gpt-5-codex' } });
    await waitFor(() => {
      expect(mock.api.editTaskModel).toHaveBeenCalledWith('task-ai', 'openai/gpt-5-codex');
    });
  });

  it('clicking a task expands a minimized inspector', async () => {
    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-planning'));
    act(() => mock.setTasks([alpha, beta], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-a')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('rf__node-wf-a'));
    await waitFor(() => {
      expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText('Minimize inspector'));
    expect(await screen.findByLabelText('Maximize inspector')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('rf__node-task-alpha'));

    await waitFor(() => {
      expect(screen.getByLabelText('Minimize inspector')).toBeInTheDocument();
      expect(screen.getByText('echo hello-alpha')).toBeInTheDocument();
    });
    expect(screen.queryByLabelText('Maximize inspector')).not.toBeInTheDocument();
  });

  it('clicking workflow graph background dismisses the selected mini DAG', async () => {
    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-planning'));
    act(() => mock.setTasks([alpha, beta], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-a')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('workflow-node-wf-a'));
    await waitFor(() => {
      expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Workflow A');
    });

    fireEvent.click(screen.getByTestId('workflow-graph-react-flow'));

    await waitFor(() => {
      expect(screen.queryByTestId('selected-workflow-mini-dag')).not.toBeInTheDocument();
    });
  });

  it('clicking inside the mini DAG panel keeps the workflow selected', async () => {
    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-planning'));
    act(() => mock.setTasks([alpha, beta], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-a')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('workflow-node-wf-a'));
    const panel = await screen.findByTestId('selected-workflow-mini-dag');
    fireEvent.click(panel);

    expect(screen.getByTestId('selected-workflow-mini-dag')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Workflow A');
  });

  it('drags the selected workflow mini DAG by its header', async () => {
    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-planning'));
    act(() => mock.setTasks([alpha, beta], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-a')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('workflow-node-wf-a'));
    const panel = await screen.findByTestId('selected-workflow-mini-dag');
    const surface = screen.getByTestId('workflow-graph-surface');
    const handle = screen.getByTestId('selected-workflow-mini-dag-drag-handle');

    Object.defineProperty(surface, 'clientWidth', { configurable: true, value: 900 });
    Object.defineProperty(surface, 'clientHeight', { configurable: true, value: 600 });
    Object.defineProperty(panel, 'offsetWidth', { configurable: true, value: 420 });
    Object.defineProperty(panel, 'offsetHeight', { configurable: true, value: 280 });
    surface.getBoundingClientRect = vi.fn(() => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 900,
      bottom: 600,
      width: 900,
      height: 600,
      toJSON: () => ({}),
    }));
    panel.getBoundingClientRect = vi.fn(() => ({
      x: 468,
      y: 12,
      left: 468,
      top: 12,
      right: 888,
      bottom: 292,
      width: 420,
      height: 280,
      toJSON: () => ({}),
    }));

    fireEvent(handle, new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 500, clientY: 20 }));
    fireEvent(handle, new MouseEvent('pointermove', { bubbles: true, clientX: 420, clientY: 80 }));
    fireEvent(handle, new MouseEvent('pointerup', { bubbles: true, clientX: 420, clientY: 80 }));

    expect(panel).toHaveStyle({ left: '388px', top: '72px' });
  });

  it('clamps the selected workflow mini DAG inside the graph surface while dragging', async () => {
    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-planning'));
    act(() => mock.setTasks([alpha, beta], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-a')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('workflow-node-wf-a'));
    const panel = await screen.findByTestId('selected-workflow-mini-dag');
    const surface = screen.getByTestId('workflow-graph-surface');
    const handle = screen.getByTestId('selected-workflow-mini-dag-drag-handle');

    Object.defineProperty(surface, 'clientWidth', { configurable: true, value: 900 });
    Object.defineProperty(surface, 'clientHeight', { configurable: true, value: 600 });
    Object.defineProperty(panel, 'offsetWidth', { configurable: true, value: 420 });
    Object.defineProperty(panel, 'offsetHeight', { configurable: true, value: 280 });
    surface.getBoundingClientRect = vi.fn(() => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 900,
      bottom: 600,
      width: 900,
      height: 600,
      toJSON: () => ({}),
    }));
    panel.getBoundingClientRect = vi.fn(() => ({
      x: 468,
      y: 12,
      left: 468,
      top: 12,
      right: 888,
      bottom: 292,
      width: 420,
      height: 280,
      toJSON: () => ({}),
    }));

    fireEvent(handle, new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 500, clientY: 20 }));
    fireEvent(handle, new MouseEvent('pointermove', { bubbles: true, clientX: 1200, clientY: 900 }));
    fireEvent(handle, new MouseEvent('pointerup', { bubbles: true, clientX: 1200, clientY: 900 }));

    expect(panel).toHaveStyle({ left: '468px', top: '308px' });
  });

  it('opens and closes the maximized graph without clearing selection', async () => {
    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-planning'));
    act(() => mock.setTasks([alpha, beta], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-a')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('workflow-node-wf-a'));
    await waitFor(() => {
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Workflow A');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Full graph ⤢' }));
    expect(screen.getByTestId('graph-maximized-overlay')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByTestId('graph-maximized-overlay')).not.toBeInTheDocument();
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Workflow A');
    });
  });
});
