/**
 * Regression: background-driven selection changes must not issue camera moves.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../types.js';
import * as ReactFlowModule from '@xyflow/react';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const fitViewMock = (ReactFlowModule as unknown as { __fitViewMock: Mock }).__fitViewMock;
const setCenterMock = (ReactFlowModule as unknown as { __setCenterMock: Mock }).__setCenterMock;
const getZoomMock = (ReactFlowModule as unknown as { __getZoomMock: Mock }).__getZoomMock;

const { App } = await import('../App.js');

const workflows: WorkflowMeta[] = [
  { id: 'wf-a', name: 'Alpha Workflow', status: 'running' },
  { id: 'wf-b', name: 'Beta Workflow', status: 'running' },
];

const tasks = [
  makeUITask({ id: 'wf-a/one', description: 'Alpha Task One', workflowId: 'wf-a', status: 'running', command: 'echo a1' }),
  makeUITask({ id: 'wf-a/two', description: 'Alpha Task Two', workflowId: 'wf-a', status: 'pending', command: 'echo a2', dependencies: ['wf-a/one'] }),
  makeUITask({ id: 'wf-b/one', description: 'Beta Task One', workflowId: 'wf-b', status: 'running', command: 'echo b1' }),
];

/** Yield past `count` animation frames so scheduled camera moves can run. */
async function flushFrames(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }
}

async function settleCamera(): Promise<void> {
  let stable = 0;
  let prev = setCenterMock.mock.calls.length + fitViewMock.mock.calls.length;
  for (let i = 0; i < 40 && stable < 4; i += 1) {
    await flushFrames(1);
    const total = setCenterMock.mock.calls.length + fitViewMock.mock.calls.length;
    if (total === prev) {
      stable += 1;
    } else {
      stable = 0;
      prev = total;
    }
  }
}

describe('Browser-surface camera (component)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
        setItem: (key: string, value: string) => { store.set(key, String(value)); },
        removeItem: (key: string) => { store.delete(key); },
        clear: () => { store.clear(); },
        key: (index: number) => [...store.keys()][index] ?? null,
        get length() { return store.size; },
      },
    });
    mock = createMockInvoker();
    mock.install();
    fitViewMock.mockClear();
    setCenterMock.mockClear();
    getZoomMock.mockReset();
    getZoomMock.mockReturnValue(1);
  });

  afterEach(() => {
    mock.cleanup();
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('a background auto-select reshuffle changes selection but issues no camera command', async () => {
    mock.setTasks(tasks, workflows);
    render(<App />);

    fireEvent.click(await screen.findByTestId('rf__node-wf-b'));
    await waitFor(() => expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Beta Workflow'));

    fireEvent.click(screen.getByTestId('rail-queue'));
    await settleCamera();
    fitViewMock.mockClear();
    setCenterMock.mockClear();

    act(() => {
      mock.fireWorkflowsChanged([workflows[0]]);
    });

    await waitFor(() => expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Alpha Workflow'));
    await flushFrames(6);

    expect(setCenterMock).not.toHaveBeenCalled();
    expect(fitViewMock).not.toHaveBeenCalled();
  });

  it('a workflow-mutation-failed event selects the failed task but issues no camera command', async () => {
    mock.setTasks(tasks, workflows);
    render(<App />);

    await waitFor(() => expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Alpha Workflow'));
    await settleCamera();
    fitViewMock.mockClear();
    setCenterMock.mockClear();

    act(() => {
      mock.fireWorkflowMutationFailed({
        workflowId: 'wf-a',
        taskId: 'wf-a/two',
        message: 'Mutation failed',
      });
    });

    await waitFor(() => expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Alpha Task Two'));
    await flushFrames(6);

    expect(setCenterMock).not.toHaveBeenCalled();
    expect(fitViewMock).not.toHaveBeenCalled();
  });
});
