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
import { CAMERA_LOCK_PREFERENCE_STORAGE_KEY } from '../lib/graph-camera.js';
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
    fireEvent.click(await screen.findByTestId('sidebar-planning'));
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
    fitViewMock.mockClear();
    setCenterMock.mockClear();
    getZoomMock.mockReset();
    getZoomMock.mockReturnValue(1);
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('Refresh button calls refreshTaskGraph', async () => {
    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-planning'));
    fireEvent.click(screen.getByTestId('rail-refresh'));

    await waitFor(() => {
      expect(mock.api.refreshTaskGraph).toHaveBeenCalled();
    });
  });

  it('Refresh button snapshots tasks without moving the workflow graph camera', async () => {
    await renderKeyboardFixture(mock);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fitCountBeforeRefresh = fitViewMock.mock.calls.length;
    const centerCountBeforeRefresh = setCenterMock.mock.calls.length;

    fireEvent.click(screen.getByTestId('rail-refresh'));

    await waitFor(() => {
      expect(mock.api.refreshTaskGraph).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(fitViewMock).toHaveBeenCalledTimes(fitCountBeforeRefresh);
      expect(setCenterMock).toHaveBeenCalledTimes(centerCountBeforeRefresh);
    });
    expect(screen.getByTestId('workflow-node-wf-a')).toBeInTheDocument();
    expect(screen.getByTestId('selected-workflow-mini-dag')).toBeInTheDocument();
  });

  it('Clear button calls clear', async () => {
    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-planning'));
    fireEvent.click(screen.getByTestId('graph-more-button'));
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

  it('tabs into the inspector onto the first sidebar navigation item and roves with Up/Down', async () => {
    await renderKeyboardFixture(mock);

    key('Tab');
    key('Tab');

    const minimize = screen.getByLabelText('Minimize inspector');
    await waitFor(() => expect(minimize).toHaveFocus());
    expect(minimize).toHaveAttribute('data-sidebar-nav-item');
    expect(minimize).toHaveAttribute('data-sidebar-nav-order', '10');

    const advanced = screen.getByTestId('inspector-advanced-disclosure');
    expect(advanced).toHaveAttribute('data-sidebar-nav-order', '90');
    key('ArrowDown');
    await waitFor(() => expect(advanced).toHaveFocus());

    key('ArrowDown');
    expect(advanced).toHaveFocus();

    key('ArrowUp');
    await waitFor(() => expect(minimize).toHaveFocus());
    key('ArrowUp');
    expect(minimize).toHaveFocus();
  });

  it('makes the sidebar a keyboard destination: first item, PR link without opening, no wrap, Right toggles Advanced', async () => {
    const reviewWorkflows: WorkflowMeta[] = [
      { id: 'wf-pr', name: 'Review Workflow', status: 'review_ready' },
    ];
    const reviewTasks = [
      makeUITask({ id: 'wf-pr/build', description: 'Build Task', workflowId: 'wf-pr', command: 'echo build' }),
      makeUITask({
        id: 'wf-pr/merge',
        description: 'Merge Task',
        workflowId: 'wf-pr',
        isMergeNode: true,
        status: 'review_ready',
        command: 'merge',
        execution: { reviewUrl: 'https://github.com/acme/repo/pull/7' },
      }),
    ];

    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    try {
      mock.setTasks(reviewTasks, reviewWorkflows);
      render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-planning'));
      await screen.findByTestId('workflow-node-wf-pr');
      await screen.findByTestId('selected-workflow-mini-dag');

      key('Tab');
      key('Tab');

      const inspectorRegion = document.querySelector('[data-keyboard-region="inspector"]');
      const minimize = screen.getByLabelText('Minimize inspector');
      await waitFor(() => expect(minimize).toHaveFocus());
      expect(minimize).toHaveAttribute('data-sidebar-nav-item');
      expect(minimize).toHaveAttribute('data-sidebar-nav-order', '10');
      expect(document.activeElement).not.toBe(inspectorRegion);

      const prLink = screen.getByTestId('inspector-pr-link');
      const advanced = screen.getByTestId('inspector-advanced-disclosure');
      expect(prLink).toHaveAttribute('data-sidebar-nav-order', '30');
      expect(advanced).toHaveAttribute('data-sidebar-nav-order', '90');

      key('ArrowDown');
      await waitFor(() => expect(prLink).toHaveFocus());
      expect(document.activeElement).toBe(prLink);
      expect(openSpy).not.toHaveBeenCalled();

      key('ArrowDown');
      await waitFor(() => expect(advanced).toHaveFocus());
      key('ArrowDown');
      expect(advanced).toHaveFocus();

      key('ArrowUp');
      await waitFor(() => expect(prLink).toHaveFocus());
      key('ArrowUp');
      await waitFor(() => expect(minimize).toHaveFocus());
      key('ArrowUp');
      expect(minimize).toHaveFocus();

      key('ArrowDown');
      key('ArrowDown');
      await waitFor(() => expect(advanced).toHaveFocus());
      expect(advanced).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByText(/workflow id:/)).not.toBeInTheDocument();

      key('ArrowRight');
      await waitFor(() => expect(advanced).toHaveAttribute('aria-expanded', 'true'));
      expect(screen.getByText(/workflow id:/)).toBeInTheDocument();

      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
    }
  });

  it('collapses and expands the inspector from its sidebar buttons', async () => {
    await renderKeyboardFixture(mock);

    fireEvent.click(screen.getByLabelText('Minimize inspector'));
    expect(await screen.findByLabelText('Maximize inspector')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Maximize inspector'));
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

describe('Sidebar keyboard navigation (component)', () => {
  let mock: MockInvoker;

  const reviewWorkflows: WorkflowMeta[] = [
    { id: 'wf-r', name: 'Review Workflow', status: 'review_ready' },
  ];

  const reviewUrl = 'https://github.com/acme/repo/pull/42';
  const reviewTasks = [
    makeUITask({
      id: 'wf-r/build',
      description: 'Build Task',
      workflowId: 'wf-r',
      command: 'echo build',
    }),
    makeUITask({
      id: 'wf-r/merge',
      description: 'Merge Task',
      workflowId: 'wf-r',
      isMergeNode: true,
      status: 'review_ready',
      dependencies: ['wf-r/build'],
      execution: { reviewUrl },
    }),
  ];

  beforeEach(() => {
    mock = createMockInvoker();
    fitViewMock.mockClear();
    setCenterMock.mockClear();
    getZoomMock.mockReset();
    getZoomMock.mockReturnValue(1);
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  async function renderReviewFixture() {
    mock.setTasks(reviewTasks, reviewWorkflows);
    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-planning'));
    await screen.findByTestId('workflow-node-wf-r');
    await screen.findByTestId('selected-workflow-mini-dag');
    await screen.findByTestId('inspector-pr-link');
  }

  it('tabs from the task graph onto the first sidebar item, then arrows to the PR link without opening it', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    try {
      await renderReviewFixture();

      key('Tab');
      key('Tab');

      const minimize = screen.getByLabelText('Minimize inspector');
      await waitFor(() => expect(minimize).toHaveFocus());
      expect(document.querySelector('[data-keyboard-region="inspector"]')).not.toHaveFocus();
      expect(minimize).toHaveAttribute('data-sidebar-nav-order', '10');

      const prLink = screen.getByTestId('inspector-pr-link');
      expect(prLink).toHaveAttribute('data-sidebar-nav-order', '30');
      key('ArrowDown');
      await waitFor(() => expect(prLink).toHaveFocus());

      expect(openSpy).not.toHaveBeenCalled();
      expect(prLink).toHaveFocus();
    } finally {
      openSpy.mockRestore();
    }
  });

  it('stops at the last item on ArrowDown and the first item on ArrowUp without wrapping', async () => {
    await renderReviewFixture();

    key('Tab');
    key('Tab');

    const minimize = screen.getByLabelText('Minimize inspector');
    const prLink = screen.getByTestId('inspector-pr-link');
    const advanced = screen.getByTestId('inspector-advanced-disclosure');
    await waitFor(() => expect(minimize).toHaveFocus());
    expect(minimize).toHaveAttribute('data-sidebar-nav-order', '10');
    expect(prLink).toHaveAttribute('data-sidebar-nav-order', '30');
    expect(advanced).toHaveAttribute('data-sidebar-nav-order', '90');

    key('ArrowDown');
    await waitFor(() => expect(prLink).toHaveFocus());
    key('ArrowDown');
    await waitFor(() => expect(advanced).toHaveFocus());
    key('ArrowDown');
    expect(advanced).toHaveFocus();

    key('ArrowUp');
    await waitFor(() => expect(prLink).toHaveFocus());
    key('ArrowUp');
    await waitFor(() => expect(minimize).toHaveFocus());
    key('ArrowUp');
    expect(minimize).toHaveFocus();
  });

  it('Right toggles the focused Advanced metadata disclosure', async () => {
    await renderReviewFixture();

    key('Tab');
    key('Tab');

    const advanced = screen.getByTestId('inspector-advanced-disclosure');
    await waitFor(() => expect(screen.getByLabelText('Minimize inspector')).toHaveFocus());

    key('ArrowDown');
    key('ArrowDown');
    await waitFor(() => expect(advanced).toHaveFocus());
    expect(advanced).toHaveAttribute('aria-expanded', 'false');

    key('ArrowRight');
    await waitFor(() => expect(advanced).toHaveAttribute('aria-expanded', 'true'));
    expect(screen.getByText(/workflow id:/)).toBeInTheDocument();

    key('ArrowRight');
    await waitFor(() => expect(advanced).toHaveAttribute('aria-expanded', 'false'));
  });
});

/**
 * Camera-lock keyboard/mouse contract at the App level. These prove the App
 * owns camera intent (selection, active scope, lock preference, suppression)
 * and that React Flow only moves when the App issues a typed command. Each
 * setCenter call here flows from App → the correctly-scoped graph component.
 */
describe('Camera lock controls (component)', () => {
  let mock: MockInvoker;
  /** Active getBoundingClientRect spy, restored after each test. */
  let rectSpy: ReturnType<typeof vi.spyOn> | null = null;

  const threeWorkflows: WorkflowMeta[] = [
    { id: 'wf-a', name: 'Alpha Workflow', status: 'running' },
    { id: 'wf-b', name: 'Beta Workflow', status: 'pending' },
    { id: 'wf-c', name: 'Gamma Workflow', status: 'pending' },
  ];

  const threeTasks = [
    makeUITask({ id: 'wf-a/t', description: 'Alpha Task', workflowId: 'wf-a', command: 'echo a' }),
    makeUITask({ id: 'wf-b/t', description: 'Beta Task', workflowId: 'wf-b', command: 'echo b' }),
    makeUITask({ id: 'wf-c/t', description: 'Gamma Task', workflowId: 'wf-c', command: 'echo c' }),
  ];

  beforeEach(() => {
    // jsdom in this project ships without localStorage, but the App persists
    // the camera-lock preference there. Install a fresh in-memory shim so seeded
    // preferences load and toggles round-trip within a test.
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => { store.set(k, String(v)); },
        removeItem: (k: string) => { store.delete(k); },
        clear: () => { store.clear(); },
        key: (i: number) => [...store.keys()][i] ?? null,
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
    rectSpy?.mockRestore();
    rectSpy = null;
    mock.cleanup();
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  /**
   * Render the App, wait for both graph surfaces to finish their initial fit,
   * then clear the viewport spies so a test asserts only on post-mount camera
   * moves. Seed localStorage BEFORE calling this to control the lock.
   */
  async function renderAndSettle(
    wfs: WorkflowMeta[] = workflows,
    tks = tasks,
  ) {
    mock.setTasks(tks, wfs);
    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-planning'));
    await screen.findByTestId(`workflow-node-${wfs[0].id}`);
    await screen.findByTestId('selected-workflow-mini-dag');
    await waitFor(() => expect(fitViewMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    // Opening Plan graph issues a fit; drain any trailing center/fit from that
    // transition before tests assert on post-mount camera moves.
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    fitViewMock.mockClear();
    setCenterMock.mockClear();
  }

  /** Flush a single animation frame so any scheduled camera move can run. */
  function flushFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  }

  function keyFromActiveElement(keyName: string) {
    fireEvent.keyDown(document.activeElement ?? document, { key: keyName });
  }

  /**
   * Stub getBoundingClientRect by data-testid so arrow navigation sees real
   * geometry (jsdom otherwise reports every rect as 0×0). `lefts` maps a node
   * testid to its left edge; each node is 200×80, so center.x = left + 100.
   */
  function stubNodeRects(lefts: Record<string, number>) {
    rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        const testId = this.getAttribute('data-testid') ?? '';
        const left = lefts[testId];
        if (left === undefined) {
          return {
            x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
            toJSON() {},
          } as DOMRect;
        }
        return {
          x: left, y: 100, top: 100, left, right: left + 200, bottom: 180,
          width: 200, height: 80, toJSON() {},
        } as DOMRect;
      },
    );
  }

  it('F1 toggle mode defaults on, toggles off then on, and re-centers the selection when re-enabled', async () => {
    await renderAndSettle();

    // Default region is the workflow graph with wf-a selected. The lock is on
    // by default, so the first F1 toggles it OFF (no camera move).
    key('F1');
    await flushFrame();
    expect(setCenterMock).not.toHaveBeenCalled();

    // The second F1 toggles the lock back ON and immediately centers wf-a.
    key('F1');
    await waitFor(() => expect(setCenterMock).toHaveBeenCalledTimes(1));
    // Lock-driven centering preserves zoom; it never whole-graph fits.
    expect(fitViewMock).not.toHaveBeenCalled();
    // The toggled preference is persisted.
    expect(JSON.parse(localStorage.getItem(CAMERA_LOCK_PREFERENCE_STORAGE_KEY)!)).toEqual({
      mode: 'toggle',
      enabled: true,
    });
  });

  it('F1 once mode centers once without changing the lock preference', async () => {
    localStorage.setItem(
      CAMERA_LOCK_PREFERENCE_STORAGE_KEY,
      JSON.stringify({ mode: 'once', enabled: true }),
    );
    await renderAndSettle();

    key('F1');
    await waitFor(() => expect(setCenterMock).toHaveBeenCalledTimes(1));
    // Once mode must not rewrite the persisted preference.
    expect(JSON.parse(localStorage.getItem(CAMERA_LOCK_PREFERENCE_STORAGE_KEY)!)).toEqual({
      mode: 'once',
      enabled: true,
    });

    // Once mode re-centers on each press (it never disables the lock).
    key('F1');
    await waitFor(() => expect(setCenterMock).toHaveBeenCalledTimes(2));
  });

  it('a manual background pan or wheel does not autofocus the graph', async () => {
    await renderAndSettle();

    const pane = screen.getAllByTestId('rf__pane')[0];
    fireEvent.pointerDown(pane);
    fireEvent.wheel(pane);

    await flushFrame();
    expect(setCenterMock).not.toHaveBeenCalled();
    expect(fitViewMock).not.toHaveBeenCalled();
  });

  it('clicking a workflow node centers it when the lock is enabled', async () => {
    await renderAndSettle();

    fireEvent.click(screen.getByTestId('workflow-node-wf-b'));

    // Selecting wf-b re-centers the workflow graph on it. (A fresh mini-dag for
    // wf-b legitimately fits once on mount, so we assert only the recenter.)
    await waitFor(() => expect(setCenterMock).toHaveBeenCalledTimes(1));
  });

  it('clicking a workflow node does not center when the lock is disabled', async () => {
    localStorage.setItem(
      CAMERA_LOCK_PREFERENCE_STORAGE_KEY,
      JSON.stringify({ mode: 'toggle', enabled: false }),
    );
    await renderAndSettle();

    fireEvent.click(screen.getByTestId('workflow-node-wf-b'));

    await flushFrame();
    expect(setCenterMock).not.toHaveBeenCalled();
  });

  it('arrow navigation re-centers the newly selected node when the lock is enabled', async () => {
    await renderAndSettle();

    key('ArrowRight');

    await waitFor(() => expect(setCenterMock).toHaveBeenCalledTimes(1));
  });

  it('keyboard-opened workflow menu handles arrows and restores workflow graph control', async () => {
    await renderAndSettle();
    await flushFrame();
    fitViewMock.mockClear();
    setCenterMock.mockClear();

    key('Enter');

    expect(await screen.findByRole('menu')).toHaveTextContent('Open Workflow');
    const openWorkflow = screen.getByRole('menuitem', { name: 'Open Workflow' });
    await waitFor(() => expect(openWorkflow).toHaveFocus());
    await flushFrame();
    expect(setCenterMock).not.toHaveBeenCalled();
    expect(fitViewMock).not.toHaveBeenCalled();

    keyFromActiveElement('ArrowDown');

    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Open PR' })).toHaveFocus());
    await flushFrame();
    expect(setCenterMock).not.toHaveBeenCalled();
    expect(fitViewMock).not.toHaveBeenCalled();

    keyFromActiveElement('Escape');

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('workflow-graph-surface')).toHaveFocus());

    key('ArrowRight');

    await waitFor(() => {
      expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Beta Workflow task DAG');
    });
    await waitFor(() => expect(setCenterMock).toHaveBeenCalledTimes(1));
  });

  it('keyboard-opened task menu handles arrows and restores task graph control', async () => {
    await renderAndSettle();

    key('Tab');
    key('ArrowRight');
    await waitFor(() => {
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Second Task');
    });
    await waitFor(() => expect(setCenterMock).toHaveBeenCalledTimes(1));
    fitViewMock.mockClear();
    setCenterMock.mockClear();

    key('Enter');

    expect(await screen.findByRole('menu')).toHaveTextContent('Open Terminal');
    const restartTask = screen.getByRole('menuitem', { name: 'Restart Task' });
    await waitFor(() => expect(restartTask).toHaveFocus());
    await flushFrame();
    expect(setCenterMock).not.toHaveBeenCalled();
    expect(fitViewMock).not.toHaveBeenCalled();

    keyFromActiveElement('ArrowDown');

    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Open Terminal' })).toHaveFocus());
    await flushFrame();
    expect(setCenterMock).not.toHaveBeenCalled();
    expect(fitViewMock).not.toHaveBeenCalled();

    keyFromActiveElement('Escape');

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    const taskGraphRegion = screen
      .getByTestId('selected-workflow-mini-dag')
      .querySelector<HTMLElement>('[data-keyboard-region="taskGraph"]');
    expect(taskGraphRegion).not.toBeNull();
    await waitFor(() => expect(taskGraphRegion).toHaveFocus());

    key('ArrowLeft');

    await waitFor(() => {
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Alpha Task');
    });
    await waitFor(() => expect(setCenterMock).toHaveBeenCalledTimes(1));
  });

  it('arrow navigation selects the geometrically nearest node, not the alphabetical neighbor', async () => {
    await renderAndSettle(threeWorkflows, threeTasks);

    // wf-a is current (center 100). To its right, wf-c (center 200) is nearer
    // than wf-b (center 300). The alphabetical neighbor would be wf-b, so
    // landing on wf-c proves arrow nav uses geometry.
    stubNodeRects({
      'workflow-node-wf-a': 0,
      'workflow-node-wf-b': 200,
      'workflow-node-wf-c': 100,
    });

    key('ArrowRight');

    await waitFor(() => {
      expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Gamma Workflow task DAG');
    });
  });

  it('arrow navigation stays put when there is no node further in that direction', async () => {
    await renderAndSettle(threeWorkflows, threeTasks);

    // Lay nodes left→right as wf-a, wf-b, wf-c so wf-c is both the rightmost
    // node and the alphabetically-last one — the boundary where ArrowRight has
    // nowhere to go and must not move the selection.
    stubNodeRects({
      'workflow-node-wf-a': 0,
      'workflow-node-wf-b': 200,
      'workflow-node-wf-c': 400,
    });

    // Select the rightmost node first, and wait for its recenter to fire so the
    // pending animation frame can't leak into the assertion below.
    fireEvent.click(screen.getByTestId('workflow-node-wf-c'));
    await waitFor(() => {
      expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Gamma Workflow task DAG');
    });
    await waitFor(() => expect(setCenterMock).toHaveBeenCalled());
    setCenterMock.mockClear();

    key('ArrowRight');

    await flushFrame();
    // Selection unchanged and no recenter was issued.
    expect(setCenterMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Gamma Workflow task DAG');
  });

});
