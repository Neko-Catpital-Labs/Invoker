/**
 * Component test: side rail controls (Refresh, Clear).
 *
 * Demoted from packages/app/e2e/keyboard-controls.spec.ts.
 * Dropped: Ctrl+Backtick terminal toggle, terminal toggle bar (Electron shell features).
 */

import { describe, it, expect, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../types.js';
import { CAMERA_LOCK_PREFERENCE_STORAGE_KEY } from '../lib/graph-camera.js';
import * as ReactFlowModule from '@xyflow/react';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const setCenterMock = (ReactFlowModule as unknown as { __setCenterMock: Mock }).__setCenterMock;
const fitViewMock = (ReactFlowModule as unknown as { __fitViewMock: Mock }).__fitViewMock;

const { App } = await import('../App.js');

const workflows: WorkflowMeta[] = [
  { id: 'wf-a', name: 'Alpha Workflow', status: 'running' },
  { id: 'wf-b', name: 'Beta Workflow', status: 'pending' },
];

const tasks = [
  makeUITask({
    id: 'wf-a/task-a',
    description: 'Alpha Task',
    workflowId: 'wf-a',
    command: 'echo alpha',
  }),
  makeUITask({
    id: 'wf-a/task-b',
    description: 'Second Task',
    workflowId: 'wf-a',
    command: 'echo second',
    dependencies: ['wf-a/task-a'],
  }),
  makeUITask({
    id: 'wf-b/task-c',
    description: 'Beta Task',
    workflowId: 'wf-b',
    command: 'echo beta',
  }),
];

async function renderKeyboardFixture(mock: MockInvoker) {
  mock.setTasks(tasks, workflows);
  render(<App />);
  await screen.findByTestId('workflow-node-wf-a');
  await screen.findByTestId('selected-workflow-mini-dag');
}

function key(keyName: string, init: Partial<KeyboardEvent> = {}) {
  fireEvent.keyDown(document, { key: keyName, ...init });
}

describe('Side rail controls (component)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('Refresh button calls getTasks with forceRefresh=true', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('rail-refresh'));

    await waitFor(() => {
      expect(mock.api.getTasks).toHaveBeenCalled();
      expect(mock.api.getTasks).toHaveBeenLastCalledWith(true);
    });
  });

  it('Clear button calls clear', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('rail-clear'));

    await waitFor(() => {
      expect(mock.api.clear).toHaveBeenCalled();
    });
  });

  it('cycles major keyboard regions with Tab', async () => {
    await renderKeyboardFixture(mock);

    expect(screen.getByTestId('workflow-graph-surface')).toHaveAttribute('data-keyboard-active', 'true');
    key('Tab');
    expect(screen.getByTestId('selected-workflow-mini-dag').querySelector('[data-keyboard-region="taskGraph"]')).toHaveAttribute('data-keyboard-active', 'true');
    key('Tab');
    expect(document.querySelector('[data-keyboard-region="inspector"]')).toHaveAttribute('data-keyboard-active', 'true');
    key('Tab');
    expect(document.querySelector('[data-keyboard-region="bottomBar"]')).toHaveAttribute('data-keyboard-active', 'true');
  });

  it('navigates workflow nodes with arrows and opens workflow menu with Enter', async () => {
    await renderKeyboardFixture(mock);

    key('ArrowRight');
    await waitFor(() => {
      expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Beta Workflow task DAG');
    });

    key('Enter');
    expect(await screen.findByRole('menu')).toHaveTextContent('Open Workflow');
  });

  it('navigates task nodes with arrows and opens task menu with Enter', async () => {
    await renderKeyboardFixture(mock);

    key('Tab');
    key('ArrowRight');
    await waitFor(() => {
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Second Task');
    });

    key('Enter');
    expect(await screen.findByRole('menu')).toHaveTextContent('Open Terminal');
  });

  it('expands and collapses the inspector with region arrow keys', async () => {
    await renderKeyboardFixture(mock);

    key('Tab');
    key('Tab');
    key('ArrowRight');
    expect(await screen.findByLabelText('Maximize inspector')).toBeInTheDocument();

    key('ArrowLeft');
    expect(await screen.findByLabelText('Minimize inspector')).toBeInTheDocument();
  });

  it('expands and collapses the terminal drawer from the bottom region', async () => {
    await renderKeyboardFixture(mock);

    key('Tab');
    key('Tab');
    key('Tab');
    key('ArrowUp');
    expect(await screen.findByTestId('terminal-drawer-body')).toBeInTheDocument();

    key('ArrowDown');
    await waitFor(() => {
      expect(screen.queryByTestId('terminal-drawer-body')).not.toBeInTheDocument();
    });
  });

  it('opens search with double Shift and activates workflow and task results', async () => {
    await renderKeyboardFixture(mock);

    key('Shift');
    key('Shift');
    const input = await screen.findByTestId('keyboard-search-input');
    fireEvent.change(input, { target: { value: 'beta workflow' } });
    key('Enter');
    await waitFor(() => {
      expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Beta Workflow task DAG');
    });

    key('Shift');
    key('Shift');
    const taskInput = await screen.findByTestId('keyboard-search-input');
    fireEvent.change(taskInput, { target: { value: 'second task' } });
    key('Enter');
    await waitFor(() => {
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Second Task');
    });
  });

  it('Escape from task graph keyboard focus dismisses selected-workflow-mini-dag and reactivates workflow graph', async () => {
    await renderKeyboardFixture(mock);

    key('Tab');
    expect(
      screen
        .getByTestId('selected-workflow-mini-dag')
        .querySelector('[data-keyboard-region="taskGraph"]'),
    ).toHaveAttribute('data-keyboard-active', 'true');

    key('Escape');

    await waitFor(() => {
      expect(screen.queryByTestId('selected-workflow-mini-dag')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('workflow-graph-surface')).toHaveAttribute(
      'data-keyboard-active',
      'true',
    );
  });

  it('Space from workflow graph keyboard focus opens the selected workflow task graph', async () => {
    await renderKeyboardFixture(mock);

    expect(screen.getByTestId('workflow-graph-surface')).toHaveAttribute(
      'data-keyboard-active',
      'true',
    );

    key(' ');

    const miniDag = await screen.findByTestId('selected-workflow-mini-dag');
    await waitFor(() => {
      expect(miniDag.querySelector('[data-keyboard-region="taskGraph"]')).toHaveAttribute(
        'data-keyboard-active',
        'true',
      );
    });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('Enter from workflow graph keyboard focus still opens the workflow context menu', async () => {
    await renderKeyboardFixture(mock);

    key('Enter');
    expect(await screen.findByRole('menu')).toHaveTextContent('Open Workflow');
  });

  it('does not let region shortcuts steal focus while typing in search', async () => {
    await renderKeyboardFixture(mock);

    key('Shift');
    key('Shift');
    const input = await screen.findByTestId('keyboard-search-input');
    fireEvent.change(input, { target: { value: 'alpha' } });
    fireEvent.keyDown(input, { key: 'Tab' });

    expect(screen.getByTestId('keyboard-search-overlay')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-graph-surface')).toHaveAttribute('data-keyboard-active', 'true');
  });
});

// ── Graph camera lock + viewport ownership, exercised through the App ──
//
// These assert the App-owned camera contract end to end: F1 lock toggling,
// once-mode, manual-pan suppression, selection-driven recentering gated on the
// lock, and persistence across a simulated reload. The React Flow mock exposes
// setCenter/fitView so we can prove *when* the viewport actually moves.

/** In-memory Storage so the App can load/persist the camera lock preference. */
function makeMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  } as Storage;
}

function readStoredPreference(storage: Storage): unknown {
  const raw = storage.getItem(CAMERA_LOCK_PREFERENCE_STORAGE_KEY);
  return raw === null ? null : JSON.parse(raw);
}

function fireKey(keyName: string, init: Partial<KeyboardEvent> = {}) {
  fireEvent.keyDown(document, { key: keyName, ...init });
}

/** Resolve after the camera command rAF has had a chance to flush. */
async function flushFrames(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
}

describe('Graph camera lock (App integration)', () => {
  let mock: MockInvoker;
  let storage: Storage;

  const cameraWorkflows: WorkflowMeta[] = [
    { id: 'wf-a', name: 'Alpha Workflow', status: 'running' },
    { id: 'wf-b', name: 'Beta Workflow', status: 'pending' },
  ];
  const cameraTasks = [
    makeUITask({ id: 'wf-a/task-a', description: 'Alpha Task', workflowId: 'wf-a', command: 'echo a' }),
    makeUITask({ id: 'wf-b/task-c', description: 'Beta Task', workflowId: 'wf-b', command: 'echo b' }),
  ];

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
    storage = makeMemoryStorage();
    (globalThis as { localStorage?: Storage }).localStorage = storage;
    setCenterMock.mockClear();
    fitViewMock.mockClear();
  });

  afterEach(() => {
    mock.cleanup();
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  async function renderApp() {
    mock.setTasks(cameraTasks, cameraWorkflows);
    const result = render(<App />);
    await screen.findByTestId('workflow-node-wf-a');
    await screen.findByTestId('selected-workflow-mini-dag');
    return result;
  }

  it('F1 toggle mode is on by default, toggles off then on, and centers on enable', async () => {
    await renderApp();
    // Selection auto-lands on the first workflow; let the initial fit settle.
    await flushFrames();
    setCenterMock.mockClear();

    // First F1: lock was on by default, so this turns it OFF — no recenter.
    fireKey('F1');
    await flushFrames();
    expect(setCenterMock).not.toHaveBeenCalled();

    // Second F1: turning the lock back ON immediately centers the current selection.
    fireKey('F1');
    await waitFor(() => expect(setCenterMock).toHaveBeenCalled());
  });

  it('F1 once mode centers a single time without changing the persisted lock preference', async () => {
    storage.setItem(
      CAMERA_LOCK_PREFERENCE_STORAGE_KEY,
      JSON.stringify({ mode: 'once', enabled: true }),
    );
    await renderApp();
    await flushFrames();
    setCenterMock.mockClear();

    fireKey('F1');
    await waitFor(() => expect(setCenterMock).toHaveBeenCalled());

    // once mode never flips the stored preference — it stays exactly as loaded.
    expect(readStoredPreference(storage)).toEqual({ mode: 'once', enabled: true });
  });

  it('persists the lock preference across a simulated reload', async () => {
    // Default is on: selecting a different workflow recenters.
    const first = await renderApp();
    await flushFrames();
    setCenterMock.mockClear();
    fireEvent.click(screen.getByTestId('workflow-node-wf-b'));
    await waitFor(() => expect(setCenterMock).toHaveBeenCalled());

    // Disable via F1; the new preference is written to storage.
    fireKey('F1');
    await waitFor(() => {
      expect(readStoredPreference(storage)).toEqual({ mode: 'toggle', enabled: false });
    });
    first.unmount();

    // "Reload": a fresh App loads the disabled preference, so selection no longer recenters.
    setCenterMock.mockClear();
    await renderApp();
    await flushFrames();
    fireEvent.click(screen.getByTestId('workflow-node-wf-b'));
    await waitFor(() => {
      expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Beta Workflow task DAG');
    });
    await flushFrames();
    expect(setCenterMock).not.toHaveBeenCalled();
  });

  it('manual pan suppresses the lock and does not autofocus the graph', async () => {
    await renderApp();
    await flushFrames();
    setCenterMock.mockClear();
    fitViewMock.mockClear();

    expect(screen.getByTestId('workflow-graph-surface')).toHaveAttribute(
      'data-camera-suppressed',
      'false',
    );

    // A background drag on the workflow pane hands the viewport to the user.
    fireEvent.mouseDown(screen.getAllByTestId('mock-react-flow-pane')[0]);
    await waitFor(() => {
      expect(screen.getByTestId('workflow-graph-surface')).toHaveAttribute(
        'data-camera-suppressed',
        'true',
      );
    });
    // The gesture itself must not re-frame or center the graph.
    await flushFrames();
    expect(setCenterMock).not.toHaveBeenCalled();
    expect(fitViewMock).not.toHaveBeenCalled();
  });

  it('a node click clears suppression and recenters while the lock is enabled', async () => {
    await renderApp();
    await flushFrames();

    // Suppress first via a manual gesture.
    fireEvent.mouseDown(screen.getAllByTestId('mock-react-flow-pane')[0]);
    await waitFor(() => {
      expect(screen.getByTestId('workflow-graph-surface')).toHaveAttribute(
        'data-camera-suppressed',
        'true',
      );
    });
    setCenterMock.mockClear();

    // Clicking a workflow node selects it, clears suppression, and recenters.
    fireEvent.click(screen.getByTestId('workflow-node-wf-b'));
    await waitFor(() => {
      expect(screen.getByTestId('workflow-graph-surface')).toHaveAttribute(
        'data-camera-suppressed',
        'false',
      );
    });
    await waitFor(() => expect(setCenterMock).toHaveBeenCalled());
  });

  it('does not recenter on node selection while the lock is disabled', async () => {
    await renderApp();
    await flushFrames();

    fireKey('F1'); // disable the lock
    await flushFrames();
    setCenterMock.mockClear();

    fireEvent.click(screen.getByTestId('workflow-node-wf-b'));
    // Selection still changes…
    await waitFor(() => {
      expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Beta Workflow task DAG');
    });
    // …but with the lock off, the camera stays where the user left it.
    await flushFrames();
    expect(setCenterMock).not.toHaveBeenCalled();
  });

  it('arrow navigation selects a neighbor and recenters through the active lock', async () => {
    await renderApp();
    await flushFrames();
    setCenterMock.mockClear();

    fireKey('ArrowRight');
    await waitFor(() => {
      expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Beta Workflow task DAG');
    });
    await waitFor(() => expect(setCenterMock).toHaveBeenCalled());
  });

  it('arrow navigation stays put and does not recenter when there is no neighbor', async () => {
    await renderApp();
    await flushFrames();

    // Move to the last workflow first, and let its recenter fully flush.
    fireKey('ArrowRight');
    await waitFor(() => {
      expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Beta Workflow task DAG');
    });
    await waitFor(() => expect(setCenterMock).toHaveBeenCalled());
    await flushFrames();
    setCenterMock.mockClear();

    // No further node in that direction — selection holds and the camera does not move.
    fireKey('ArrowRight');
    await flushFrames();
    expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Beta Workflow task DAG');
    expect(setCenterMock).not.toHaveBeenCalled();
  });
});
