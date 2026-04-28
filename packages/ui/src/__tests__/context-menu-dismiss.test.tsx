/**
 * Regression test: context menu dismissal must not depend on document
 * mousedown bubbling.
 *
 * The fix closes from a capture-phase document mousedown listener, so outside
 * dismissal does not depend on bubbling surviving React Flow or graph-layer
 * handlers. This test encodes that directly by stopping bubbling on the click
 * target itself and asserting the menu still closes.
 *
 * Why this fails on the old implementation:
 * - the old code relied on a bubble-phase `document` mousedown listener
 * - the outside target below stops propagation during bubbling
 * - the old listener never observed the event, so the menu stayed open
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

const task = makeUITask({
  id: 'task-node-1',
  description: 'Node repro task',
  status: 'pending',
  command: 'echo repro',
  workflowId: 'wf-repro',
});

const workflows: WorkflowMeta[] = [
  { id: 'wf-repro', name: 'Repro Workflow', status: 'running', baseBranch: 'master' },
];

describe('Context menu dismissal (node-right-click regression)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  async function openContextMenu() {
    render(<App />);
    act(() => mock.setTasks([task], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('rf__node-task-node-1')).toBeInTheDocument();
    });

    fireEvent.contextMenu(screen.getByTestId('rf__node-task-node-1'));

    return screen.findByRole('menu');
  }

  it('dismisses from an outside left-click even when bubbling is stopped', async () => {
    const menu = await openContextMenu();
    expect(menu).toBeInTheDocument();

    const interceptor = document.createElement('div');
    interceptor.setAttribute('data-testid', 'outside-dismiss-target');
    interceptor.addEventListener('mousedown', (event) => {
      event.stopPropagation();
    });
    document.body.appendChild(interceptor);

    try {
      fireEvent.mouseDown(interceptor, { button: 0 });

      await waitFor(() => {
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      });
    } finally {
      interceptor.remove();
    }
  });
});
