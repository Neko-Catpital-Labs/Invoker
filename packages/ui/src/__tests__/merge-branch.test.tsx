/**
 * Component test: Merge gate branch selector in TaskPanel.
 *
 * Demoted from packages/app/e2e/merge-branch.spec.ts.
 * Tests clicking merge node shows Target Branch input, branch label, and blur persistence.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { vi } from 'vitest';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

const taskA = makeUITask({
  id: 'task-a',
  description: 'Task A',
  status: 'pending',
  command: 'echo a',
  workflowId: 'wf-1',
});

const mergeNode = makeUITask({
  id: '__merge__wf-1',
  description: 'Merge gate',
  status: 'pending',
  dependencies: ['task-a'],
  isMergeNode: true,
  workflowId: 'wf-1',
});

const workflows: WorkflowMeta[] = [
  { id: 'wf-1', name: 'Merge Branch Test', status: 'running', baseBranch: 'master' },
];

describe('Merge gate branch selector (component)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('clicking merge gate shows Target Branch input with "master"', async () => {
    render(<App />);
    act(() => mock.setTasks([taskA, mergeNode], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('rf__node-__merge__wf-1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('rf__node-__merge__wf-1'));

    await waitFor(() => {
      const input = screen.getByTestId('target-branch-input') as HTMLInputElement;
      expect(input).toBeInTheDocument();
      expect(input.value).toBe('master');
    });
  });

  it('merge gate node shows primary merge-gate label', async () => {
    render(<App />);
    act(() => mock.setTasks([taskA, mergeNode], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('merge-gate-primary-label')).toBeInTheDocument();
      expect(screen.getByTestId('merge-gate-primary-label')).toHaveTextContent('Workflow');
    });
  });

  it('changing Target Branch value persists after blur', async () => {
    render(<App />);
    act(() => mock.setTasks([taskA, mergeNode], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('rf__node-__merge__wf-1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('rf__node-__merge__wf-1'));

    await waitFor(() => {
      expect(screen.getByTestId('target-branch-input')).toBeInTheDocument();
    });

    const input = screen.getByTestId('target-branch-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'develop' } });
    fireEvent.blur(input);

    expect(input.value).toBe('develop');
  });
});
