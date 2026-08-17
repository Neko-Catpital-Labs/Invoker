import { describe, it, expect, beforeEach, afterEach, type Mock } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';
import { useState } from 'react';
import { createMockInvoker, makePlanningSessionSummary, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { TerminalSessionDescriptor } from '@invoker/contracts';
import type { TaskState, WorkflowMeta } from '../types.js';
import type { GraphCameraCommand } from '../lib/graph-camera.js';
import * as ReactFlowModule from '@xyflow/react';

const workflowGraphSpy = vi.hoisted(() => ({
  commands: [] as Array<GraphCameraCommand | null | undefined>,
  reset() {
    this.commands.length = 0;
  },
}));

vi.mock('@xyflow/react', async () => {
  // Dynamic import is required because Vitest hoists mock factories before test imports.
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

vi.mock('../components/WorkflowGraph.js', async () => {
  const actual = await vi.importActual<typeof import('../components/WorkflowGraph.js')>('../components/WorkflowGraph.js');
  return {
    ...actual,
    WorkflowGraph(props: Parameters<typeof actual.WorkflowGraph>[0]) {
      workflowGraphSpy.commands.push(props.cameraCommand);
      return actual.WorkflowGraph(props);
    },
  };
});

const xtermMock = vi.hoisted(() => {
  type DataHandler = (data: string) => void;
  type TerminalDimensions = { cols: number; rows: number };

  const instances: MockTerminal[] = [];
  const fitInstances: MockFitAddon[] = [];
  const writeLog: string[] = [];
  let nextProposedDimensions: TerminalDimensions | undefined = { cols: 80, rows: 24 };

  class MockTerminal {
    cols = 80;
    rows = 24;
    dataHandler: DataHandler | null = null;
    loadAddon = vi.fn((addon: { activate?: (terminal: MockTerminal) => void }) => {
      addon.activate?.(this);
    });
    open = vi.fn((host: HTMLElement) => {
      const terminalElement = document.createElement('div');
      terminalElement.className = 'xterm';
      terminalElement.textContent = 'mock terminal';
      host.appendChild(terminalElement);
    });
    write = vi.fn((data: string) => {
      writeLog.push(data);
    });
    onData = vi.fn((cb: DataHandler) => {
      this.dataHandler = cb;
      return { dispose: vi.fn() };
    });
    focus = vi.fn();
    refresh = vi.fn();
    dispose = vi.fn();

    constructor() {
      instances.push(this);
    }

    emitData(data: string) {
      this.dataHandler?.(data);
    }
  }

  class MockFitAddon {
    terminal: MockTerminal | null = null;
    proposedDimensions = nextProposedDimensions;
    activate = vi.fn((terminal: MockTerminal) => {
      this.terminal = terminal;
    });
    proposeDimensions = vi.fn(() => this.proposedDimensions);
    fit = vi.fn(() => {
      if (!this.terminal || !this.proposedDimensions) return;
      this.terminal.cols = this.proposedDimensions.cols;
      this.terminal.rows = this.proposedDimensions.rows;
    });

    constructor() {
      fitInstances.push(this);
    }
  }

  return {
    Terminal: MockTerminal,
    FitAddon: MockFitAddon,
    instances,
    fitInstances,
    writeLog,
    setNextProposedDimensions: (dimensions: TerminalDimensions | undefined) => {
      nextProposedDimensions = dimensions;
    },
    reset: () => {
      instances.length = 0;
      fitInstances.length = 0;
      writeLog.length = 0;
      nextProposedDimensions = { cols: 80, rows: 24 };
    },
  };
});

vi.mock('xterm', () => ({ Terminal: xtermMock.Terminal }));
vi.mock('xterm-addon-fit', () => ({ FitAddon: xtermMock.FitAddon }));

const fitViewMock = (ReactFlowModule as unknown as { __fitViewMock: Mock }).__fitViewMock;
const setCenterMock = (ReactFlowModule as unknown as { __setCenterMock: Mock }).__setCenterMock;
const setViewportMock = (ReactFlowModule as unknown as { __setViewportMock: Mock }).__setViewportMock;
const getZoomMock = (ReactFlowModule as unknown as { __getZoomMock: Mock }).__getZoomMock;
const getViewportMock = (ReactFlowModule as unknown as { __getViewportMock: Mock }).__getViewportMock;

// Dynamic imports are required so modules see the hoisted @xyflow/react mock.
const { App } = await import('../App.js');
const { InvokerTerminal, buildPlanningHarnessChoices } = await import('../components/InvokerTerminal.js');

const COMPONENT_INPUT_HANDLER_BUDGET_MS = 16;

async function flushFrames(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const { promise, resolve } = Promise.withResolvers<void>();
    requestAnimationFrame(() => resolve());
    await promise;
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

describe('Invoker terminal (component)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    xtermMock.reset();
    mock = createMockInvoker();
    mock.install();
    fitViewMock.mockClear();
    setCenterMock.mockClear();
    setViewportMock.mockClear();
    getZoomMock.mockReset();
    getZoomMock.mockReturnValue(1);
    getViewportMock.mockReset();
    getViewportMock.mockReturnValue({ x: 0, y: 0, zoom: 1 });
    workflowGraphSpy.reset();
  });

  afterEach(() => {
    mock.cleanup();
    xtermMock.reset();
  });

  async function openPlanningTerminal() {
    fireEvent.click(await screen.findByTestId('sidebar-home'));
    const expandPlanningChats = screen.queryByRole('button', { name: 'Expand planning chats' });
    if (expandPlanningChats) fireEvent.click(expandPlanningChats);
    fireEvent.click(await screen.findByRole('button', { name: 'Options' }));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });
  }

  function submitPlanningText(text: string) {
    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: text } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
  }

  function makeRailPlanningSession(
    id: string,
    title: string,
    status: 'still_discussing' | 'submitted' = 'still_discussing',
    message = title,
  ) {
    return makePlanningSessionSummary({
      id,
      title,
      status,
      messages: [
        {
          id: 1,
          role: 'user',
          text: message,
          createdAt: '2026-07-07T00:00:01.000Z',
        },
      ],
      draftPlanAvailable: false,
      draftPlanSummary: undefined,
      draftPlanText: undefined,
      updatedAt: '2026-07-07T00:00:01.000Z',
    });
  }

  function getPlanningSessionRowByText(text: string): HTMLElement {
    const rail = screen.getByTestId('planning-session-list');
    const textElement = within(rail).getAllByText(text)[0];
    const row = textElement?.closest('[data-testid="planning-session-row"]');
    if (!(row instanceof HTMLElement)) {
      throw new Error(`Missing planning session row for ${text}`);
    }
    return row;
  }

  function expectRailListScrollContract(list: HTMLElement) {
    expect(list).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto');
    expect(list.parentElement).toHaveClass('flex', 'min-h-0', 'flex-1', 'flex-col');
  }

  async function expectSurfaceRailList(surface: 'home' | 'workflows' | 'attention', listTestId: string) {
    fireEvent.click(screen.getByTestId(`sidebar-${surface}`));
    await waitFor(() => {
      expect(screen.getByTestId(`sidebar-${surface}`)).toHaveAttribute('aria-current', 'page');
    });
    expectRailListScrollContract(screen.getByTestId(listTestId));
  }

  it('renders an empty flush planning pane before the first message', async () => {
    render(<App />);
    await openPlanningTerminal();

    expect(screen.getByRole('heading', { name: 'Planning chat' })).toBeInTheDocument();
    expect(screen.getByText('Still discussing')).toBeInTheDocument();
    expect(screen.getByText('What do you want to build?')).toBeInTheDocument();
    expect(screen.getByTestId('invoker-terminal-empty-hero')).toBeInTheDocument();
    const transcript = screen.getByTestId('invoker-terminal-transcript');
    const terminalShell = transcript.closest('section');
    expect(terminalShell).not.toBeNull();
    expect(terminalShell?.className).not.toContain('border border-border');
    expect(terminalShell?.className).not.toContain('bg-card');
    expect(screen.getByTestId('invoker-terminal-input')).toBeEnabled();
  }, 10_000);

  function lastPerfPayload(metric: string): Record<string, any> {
    const payload = vi.mocked(mock.api.reportUiPerf).mock.calls
      .filter(([name]) => name === metric)
      .map(([, data]) => data as Record<string, any>)
      .at(-1);
    if (!payload) throw new Error(`Missing ${metric} perf payload`);
    return payload;
  }

  function makeManyWorkflowTypingBaseline(
    workflowCount = 8,
    messagesPerWorkflow = 12,
  ): { tasks: TaskState[]; workflows: WorkflowMeta[] } {
    const tasks: TaskState[] = [];
    const workflows: WorkflowMeta[] = [];

    for (let workflowIndex = 0; workflowIndex < workflowCount; workflowIndex += 1) {
      const workflowId = `wf-chat-${workflowIndex}`;
      workflows.push({
        id: workflowId,
        name: `Planning Chat ${workflowIndex}`,
        status: 'running',
      });

      for (let messageIndex = 0; messageIndex < messagesPerWorkflow; messageIndex += 1) {
        const messageId = `message-${String(messageIndex).padStart(2, '0')}`;
        const previousMessageId = `message-${String(messageIndex - 1).padStart(2, '0')}`;
        tasks.push(makeUITask({
          id: `${workflowId}/${messageId}`,
          description: `Planning transcript message ${workflowIndex}.${messageIndex}`,
          status: 'pending',
          workflowId,
          dependencies: messageIndex === 0 ? [] : [`${workflowId}/${previousMessageId}`],
          prompt: [
            `session=${workflowIndex}`,
            `message=${messageIndex}`,
            `content=${'planning-context '.repeat(8)}${workflowIndex}-${messageIndex}`,
          ].join('\n'),
          execution: {
            agentSessionId: `session-${workflowIndex}`,
          },
        }));
      }
    }

    return { tasks, workflows };
  }

  function expectedTranscriptMessageCount(tasks: TaskState[]): number {
    return tasks.reduce((total, task) => (
      total + (task.config.prompt?.split(/\n+/).filter((line) => line.trim().length > 0).length ?? 0)
    ), 0);
  }

  function terminalProps(overrides: Partial<Parameters<typeof InvokerTerminal>[0]> = {}) {
    return {
      activeConversationKey: 'chat-1',
      lines: [{ id: 1, text: 'First line', role: 'system' as const }],
      busy: false,
      value: '',
      selectedPresetKey: 'codex',
      presetOptions: [{ key: 'codex', label: 'Codex', tool: 'codex' }],
      selectedConfirmationMode: 'require' as const,
      draftPlanAvailable: false,
      onValueChange: vi.fn(),
      onSubmit: vi.fn(),
      onSubmitDraft: vi.fn(),
      onPresetChange: vi.fn(),
      onConfirmationModeChange: vi.fn(),
      onExpand: vi.fn(),
      ...overrides,
    };
  }

  it('groups flat configured planning presets into harness and model choices', () => {
    expect(buildPlanningHarnessChoices([
      { key: 'codex', label: 'Codex', tool: 'codex' },
      { key: 'omp+claude', label: 'Claude via OMP', tool: 'omp', model: 'claude' },
      { key: 'omp+codex', label: 'Codex via OMP', tool: 'omp', model: 'codex' },
      { key: 'omp', label: 'OMP', tool: 'omp' },
    ])).toEqual([
      {
        tool: 'codex',
        label: 'Codex',
        directPreset: { key: 'codex', label: 'Codex', tool: 'codex' },
        modelPresets: [],
      },
      {
        tool: 'omp',
        label: 'OMP',
        directPreset: { key: 'omp', label: 'OMP', tool: 'omp' },
        modelPresets: [
          { key: 'omp+claude', label: 'Claude via OMP', tool: 'omp', model: 'claude' },
          { key: 'omp+codex', label: 'Codex via OMP', tool: 'omp', model: 'codex' },
        ],
      },
    ]);
  });

  it('renders separate harness and model selectors while emitting configured preset keys', () => {
    const onPresetChange = vi.fn();
    render(<InvokerTerminal
      {...terminalProps({
        selectedPresetKey: 'omp+claude',
        presetOptions: [
          { key: 'codex', label: 'Codex', tool: 'codex' },
          { key: 'omp+claude', label: 'Claude via OMP', tool: 'omp', model: 'claude' },
          { key: 'omp+codex', label: 'Codex via OMP', tool: 'omp', model: 'codex' },
          { key: 'omp', label: 'OMP', tool: 'omp' },
        ],
        onPresetChange,
      })}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'Options' }));

    expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('omp');
    const modelSelect = screen.getByTestId('invoker-terminal-model');
    expect(modelSelect).toHaveValue('omp+claude');
    expect(within(modelSelect).getByRole('option', { name: 'Default' })).toHaveValue('omp');
    expect(within(modelSelect).getByRole('option', { name: 'Claude' })).toHaveValue('omp+claude');
    expect(within(modelSelect).getByRole('option', { name: 'Codex' })).toHaveValue('omp+codex');

    fireEvent.change(modelSelect, { target: { value: 'omp+codex' } });
    expect(onPresetChange).toHaveBeenLastCalledWith('omp+codex');
  });

  it('hides the model selector for direct harness presets without configured models', () => {
    render(<InvokerTerminal {...terminalProps()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Options' }));

    expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    expect(screen.queryByTestId('invoker-terminal-model')).not.toBeInTheDocument();
  });

  it('preserves a still-valid model when switching harnesses', () => {
    const onPresetChange = vi.fn();
    render(<InvokerTerminal
      {...terminalProps({
        selectedPresetKey: 'omp+claude',
        presetOptions: [
          { key: 'omp+claude', label: 'Claude via OMP', tool: 'omp', model: 'claude' },
          { key: 'omp+codex', label: 'Codex via OMP', tool: 'omp', model: 'codex' },
          { key: 'cursor+claude', label: 'Claude via Cursor', tool: 'cursor', model: 'claude' },
          { key: 'cursor+codex', label: 'Codex via Cursor', tool: 'cursor', model: 'codex' },
          { key: 'codex', label: 'Codex', tool: 'codex' },
        ],
        onPresetChange,
      })}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'Options' }));
    fireEvent.change(screen.getByTestId('invoker-terminal-harness'), { target: { value: 'cursor' } });
    expect(onPresetChange).toHaveBeenLastCalledWith('cursor+claude');

    fireEvent.change(screen.getByTestId('invoker-terminal-harness'), { target: { value: 'codex' } });
    expect(onPresetChange).toHaveBeenLastCalledWith('codex');
  });

  it('shows the submitted-plan bar running state while the workflow is still running', () => {
    render(<InvokerTerminal
      {...terminalProps({
        readOnly: true,
        submittedPlanName: 'Submitted Plan',
        workflowRunning: true,
        onOpenGraph: vi.fn(),
      })}
    />);

    const bar = screen.getByTestId('invoker-terminal-submitted-bar');
    expect(within(bar).getByText(/Workflow running\.\.\./)).toBeInTheDocument();
    expect(bar).toHaveTextContent('"Submitted Plan"');
    expect(bar).not.toHaveTextContent('Plan ready');
    expect(within(bar).getByTestId('invoker-terminal-open-graph')).toBeInTheDocument();
  });

  it('keeps the submitted-plan bar Plan ready content when the workflow is not running', () => {
    render(<InvokerTerminal
      {...terminalProps({
        readOnly: true,
        submittedPlanName: 'Submitted Plan',
        workflowRunning: false,
        onOpenGraph: vi.fn(),
      })}
    />);

    const bar = screen.getByTestId('invoker-terminal-submitted-bar');
    expect(bar).toHaveTextContent('Plan ready · "Submitted Plan" · review the graph, then Start ready work');
    expect(bar).not.toHaveTextContent('Workflow running');
    expect(within(bar).getByTestId('invoker-terminal-open-graph')).toBeInTheDocument();
  });

  function makePlanningTerminalSession(
    overrides: Partial<TerminalSessionDescriptor> = {},
  ): TerminalSessionDescriptor {
    return {
      sessionId: 'planning-terminal-1',
      taskId: 'planning:chat-1',
      kind: 'planning',
      planningSessionId: 'chat-1',
      status: 'running',
      mode: 'spawn',
      attached: false,
      createdAt: '2026-07-07T00:00:01.000Z',
      ...overrides,
    };
  }

  function mockElementRect(width: number, height: number) {
    return vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    } as DOMRect);
  }

  async function flushPlanningTerminalFit(): Promise<void> {
    for (let index = 0; index < 4; index += 1) {
      await act(async () => {
        await new Promise<void>((resolve) => {
          if (typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(() => resolve());
            return;
          }
          window.setTimeout(resolve, 0);
        });
      });
    }
  }

  async function waitRealMs(ms: number): Promise<void> {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
    });
  }

  it('does not mount planning tmux xterm or resize while inactive', async () => {
    render(<InvokerTerminal
      {...terminalProps({
        mode: 'tmux',
        terminalSession: makePlanningTerminalSession(),
        terminalActive: false,
      })}
    />);

    await act(async () => {});

    expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', 'planning-terminal-1');
    expect(screen.queryByText('mock terminal')).not.toBeInTheDocument();
    expect(xtermMock.instances).toHaveLength(0);
    expect(xtermMock.fitInstances).toHaveLength(0);
    expect(mock.api.onTerminalOutput).not.toHaveBeenCalled();
    expect(mock.api.planningTerminalResize).not.toHaveBeenCalled();
  });

  it('keeps the same xterm Terminal instance across a chat/tmux mode toggle', async () => {
    const rectSpy = mockElementRect(640, 400);

    try {
      const props = terminalProps({
        mode: 'tmux' as const,
        terminalSession: makePlanningTerminalSession(),
      });
      const { rerender } = render(<InvokerTerminal {...props} />);
      await flushPlanningTerminalFit();

      expect(xtermMock.instances).toHaveLength(1);
      const firstInstance = xtermMock.instances[0];

      rerender(<InvokerTerminal {...props} mode="chat" />);
      await flushPlanningTerminalFit();

      expect(xtermMock.instances).toHaveLength(1);
      expect(firstInstance?.dispose).not.toHaveBeenCalled();

      rerender(<InvokerTerminal {...props} mode="tmux" />);
      await flushPlanningTerminalFit();

      expect(xtermMock.instances).toHaveLength(1);
      expect(xtermMock.instances[0]).toBe(firstInstance);
      expect(firstInstance?.dispose).not.toHaveBeenCalled();
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('skips planning tmux fit and resize when proposed dimensions are tiny', async () => {
    const rectSpy = mockElementRect(640, 400);
    xtermMock.setNextProposedDimensions({ cols: 19, rows: 4 });

    try {
      render(<InvokerTerminal
        {...terminalProps({
          mode: 'tmux',
          terminalSession: makePlanningTerminalSession(),
        })}
      />);

      await flushPlanningTerminalFit();

      expect(xtermMock.fitInstances).toHaveLength(1);
      expect(xtermMock.fitInstances[0]?.proposeDimensions).toHaveBeenCalled();
      expect(xtermMock.fitInstances[0]?.fit).not.toHaveBeenCalled();
      expect(mock.api.planningTerminalResize).not.toHaveBeenCalled();
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('skips planning tmux fit and resize when proposed dimensions are not finite', async () => {
    const rectSpy = mockElementRect(640, 400);
    xtermMock.setNextProposedDimensions({ cols: Number.NaN, rows: 24 });

    try {
      render(<InvokerTerminal
        {...terminalProps({
          mode: 'tmux',
          terminalSession: makePlanningTerminalSession(),
        })}
      />);

      await flushPlanningTerminalFit();

      expect(xtermMock.fitInstances[0]?.proposeDimensions).toHaveBeenCalled();
      expect(xtermMock.fitInstances[0]?.fit).not.toHaveBeenCalled();
      expect(mock.api.planningTerminalResize).not.toHaveBeenCalled();
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('sends planning tmux resize when proposed dimensions are sane', async () => {
    const rectSpy = mockElementRect(640, 400);
    xtermMock.setNextProposedDimensions({ cols: 100, rows: 30 });

    try {
      render(<InvokerTerminal
        {...terminalProps({
          mode: 'tmux',
          terminalSession: makePlanningTerminalSession(),
        })}
      />);

      await flushPlanningTerminalFit();

      expect(xtermMock.fitInstances[0]?.proposeDimensions).toHaveBeenCalled();
      expect(xtermMock.fitInstances[0]?.fit).toHaveBeenCalled();
      expect(mock.api.planningTerminalResize).toHaveBeenCalledTimes(1);
      expect(mock.api.planningTerminalResize).toHaveBeenCalledWith('planning-terminal-1', 100, 30);
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('suppresses duplicate planning tmux resize dimensions', async () => {
    const rectSpy = mockElementRect(640, 400);
    xtermMock.setNextProposedDimensions({ cols: 100, rows: 30 });

    try {
      render(<InvokerTerminal
        {...terminalProps({
          mode: 'tmux',
          terminalSession: makePlanningTerminalSession(),
        })}
      />);

      await flushPlanningTerminalFit();
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      await flushPlanningTerminalFit();

      expect(xtermMock.fitInstances[0]?.fit.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(mock.api.planningTerminalResize).toHaveBeenCalledTimes(1);
      expect(mock.api.planningTerminalResize).toHaveBeenCalledWith('planning-terminal-1', 100, 30);
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('never retries a planning tmux resize the main process failed to apply', async () => {
    const rectSpy = mockElementRect(640, 400);
    xtermMock.setNextProposedDimensions({ cols: 100, rows: 30 });
    vi.mocked(mock.api.planningTerminalResize).mockResolvedValueOnce({ ok: false, reason: 'session-not-found' });

    try {
      render(<InvokerTerminal
        {...terminalProps({
          mode: 'tmux',
          terminalSession: makePlanningTerminalSession(),
        })}
      />);

      await flushPlanningTerminalFit();
      expect(mock.api.planningTerminalResize).toHaveBeenCalledTimes(1);

      // The container's real size never changed, but nothing else has
      // caused the renderer to distinguish "size we tried to send" from
      // "size the PTY actually confirmed" — a window focus event re-fits
      // to the same 100x30 and should retry, since the PTY never got it.
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      await flushPlanningTerminalFit();

      // This is the bug: the renderer treats its own failed attempt as
      // success and never resends the same dimensions, so the PTY is
      // left running at its stale/default size indefinitely.
      expect(mock.api.planningTerminalResize).toHaveBeenCalledTimes(2);
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('retries a resize the main process falsely reported as applied, using a readback check', async () => {
    const rectSpy = mockElementRect(640, 400);
    xtermMock.setNextProposedDimensions({ cols: 100, rows: 30 });

    let appliedSizeCalls = 0;
    vi.mocked(mock.api.planningTerminalAppliedSize).mockImplementation(async () => {
      appliedSizeCalls += 1;
      // First readback proves the "successful" resize never actually
      // stuck; second readback (after the forced retry) shows it caught up.
      return appliedSizeCalls === 1 ? { cols: 80, rows: 24 } : { cols: 100, rows: 30 };
    });

    try {
      render(<InvokerTerminal
        {...terminalProps({
          mode: 'tmux',
          terminalSession: makePlanningTerminalSession(),
        })}
      />);

      await flushPlanningTerminalFit();
      expect(mock.api.planningTerminalResize).toHaveBeenCalledTimes(1);

      // The main process claimed { ok: true } for that first resize, but a
      // readback a moment later shows the PTY never actually adopted it —
      // the reconcile loop must force a resend rather than trust the lie.
      await waitRealMs(700);

      expect(mock.api.planningTerminalAppliedSize).toHaveBeenCalledWith('planning-terminal-1');
      expect(mock.api.planningTerminalResize).toHaveBeenCalledTimes(2);

      // Once the readback confirms the retry actually stuck, the loop must
      // stop — no further resize calls should appear after another round.
      const callsAfterRetry = mock.api.planningTerminalResize.mock.calls.length;
      await waitRealMs(700);
      expect(mock.api.planningTerminalResize.mock.calls.length).toBe(callsAfterRetry);
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('gives up after a bounded number of reconcile attempts against a persistently wrong size', async () => {
    const rectSpy = mockElementRect(640, 400);
    xtermMock.setNextProposedDimensions({ cols: 100, rows: 30 });

    // The main process always claims success, but the readback never
    // matches — this must not retry forever.
    vi.mocked(mock.api.planningTerminalAppliedSize).mockResolvedValue({ cols: 80, rows: 24 });

    try {
      render(<InvokerTerminal
        {...terminalProps({
          mode: 'tmux',
          terminalSession: makePlanningTerminalSession(),
        })}
      />);

      await flushPlanningTerminalFit();
      await waitRealMs(4500);

      const totalResizeCalls = mock.api.planningTerminalResize.mock.calls.length;
      expect(totalResizeCalls).toBeGreaterThan(1);

      await waitRealMs(700);
      expect(mock.api.planningTerminalResize.mock.calls.length).toBe(totalResizeCalls);
    } finally {
      rectSpy.mockRestore();
    }
  }, 12000);

  it('generates a planning reply from plain language', async () => {
    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('hello');

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledWith({ message: 'hello', presetKey: 'codex', confirmationMode: 'require' });
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('I can help draft that.');
    });
    expect(screen.queryByText(/Unknown command/)).not.toBeInTheDocument();
  });

  it('shows concise planning activity while busy and removes it when the final reply arrives', async () => {
    let resolveSend: ((value: any) => void) | null = null;
    mock.api.planningChatSend = vi.fn(() => new Promise((resolve) => {
      resolveSend = resolve;
    }) as any) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('draft a streamed plan');
    await waitFor(() => expect(mock.api.planningChatSend).toHaveBeenCalledTimes(1));

    await act(async () => {
      mock.firePlanningChatStream({ sessionId: 'session-1', chunk: 'raw planner ' });
      mock.firePlanningChatStream({ sessionId: 'session-1', chunk: 'text' });
    });

    const panel = await screen.findByTestId('invoker-terminal-planner-stream');
    expect(panel).toHaveAttribute('data-state', 'streaming');
    expect(panel).toHaveTextContent('Drafting your plan…');

    await act(async () => {
      resolveSend?.({
        ok: true,
        sessionId: 'session-1',
        reply: 'Final assistant reply.',
        draftPlanAvailable: false,
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId('invoker-terminal-planner-stream')).not.toBeInTheDocument();
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Final assistant reply.');
      expect(screen.getByTestId('invoker-terminal-transcript')).not.toHaveTextContent('raw planner text');
    });
  });

  it('keeps concise failed planning activity visible until the next send starts', async () => {
    const plannerError = 'planner exited with code 1';
    let resolveFirstSend: ((value: any) => void) | null = null;
    let resolveSecondSend: ((value: any) => void) | null = null;
    mock.api.planningChatSend = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirstSend = resolve;
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveSecondSend = resolve;
      })) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('draft a failing streamed plan');
    await waitFor(() => expect(mock.api.planningChatSend).toHaveBeenCalledTimes(1));
    await act(async () => {
      mock.firePlanningChatStream({ sessionId: 'session-1', chunk: 'partial raw output' });
    });
    expect(await screen.findByTestId('invoker-terminal-planner-stream')).toHaveTextContent('Drafting your plan…');

    await act(async () => {
      resolveFirstSend?.({ ok: false, sessionId: 'session-1', error: plannerError });
    });

    await waitFor(() => {
      const panel = screen.getByTestId('invoker-terminal-planner-stream');
      expect(panel).toHaveAttribute('data-state', 'failed');
      expect(panel).toHaveTextContent('Planning stopped. Try again when ready.');
    });

    submitPlanningText('try again');

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledTimes(2);
      expect(mock.api.planningChatSend).toHaveBeenLastCalledWith({
        sessionId: 'session-1',
        message: 'try again',
        presetKey: 'codex',
        confirmationMode: 'require',
      });
      const panel = screen.getByTestId('invoker-terminal-planner-stream');
      expect(panel).toHaveAttribute('data-state', 'working');
      expect(panel).toHaveTextContent('Working…');
    });

    await act(async () => {
      resolveSecondSend?.({
        ok: true,
        sessionId: 'session-1',
        reply: 'Recovered.',
        draftPlanAvailable: false,
      });
    });
    await waitFor(() => expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Recovered.'));
  });

  it('keeps live planning activity isolated when switching planning sessions', async () => {
    mock.api.planningChatSend = vi.fn(() => new Promise(() => {}) as any) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('first session request');
    await waitFor(() => expect(mock.api.planningChatSend).toHaveBeenCalledTimes(1));
    await act(async () => {
      mock.firePlanningChatStream({ sessionId: 'session-1', chunk: 'first raw stream' });
    });
    expect(await screen.findByTestId('invoker-terminal-planner-stream')).toHaveTextContent('Drafting your plan…');

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(screen.queryByTestId('invoker-terminal-planner-stream')).not.toBeInTheDocument();

    submitPlanningText('second session request');
    await waitFor(() => expect(mock.api.planningChatSend).toHaveBeenCalledTimes(2));
    await act(async () => {
      mock.firePlanningChatStream({ sessionId: 'session-2', chunk: 'second raw stream' });
    });

    const secondPanel = await screen.findByTestId('invoker-terminal-planner-stream');
    expect(secondPanel).toHaveTextContent('Drafting your plan…');

    fireEvent.click(within(screen.getByTestId('planning-session-list')).getByRole('button', { name: /first session request/i }));

    const firstPanel = await screen.findByTestId('invoker-terminal-planner-stream');
    expect(firstPanel).toHaveTextContent('Drafting your plan…');
  });

  it('replays planning tmux output when switching sessions back without duplicating live output', async () => {
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'plan-alpha',
          title: 'Alpha tmux session',
          status: 'still_discussing',
          draftPlanAvailable: false,
          terminalMode: 'tmux',
          terminalSessionId: 'term-alpha',
          terminalStatus: 'running',
          terminalOutputSnapshot: '',
        }),
        makePlanningSessionSummary({
          id: 'plan-beta',
          title: 'Beta tmux session',
          status: 'still_discussing',
          draftPlanAvailable: false,
          terminalMode: 'tmux',
          terminalSessionId: 'term-beta',
          terminalStatus: 'running',
          terminalOutputSnapshot: '',
        }),
      ],
    })) as any;

    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-home'));
    await waitFor(() => expect(mock.api.onTerminalOutput).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', 'term-alpha');
    });

    await act(async () => {
      mock.fireTerminalOutput({
        sessionId: 'term-alpha',
        taskId: 'planning:plan-alpha',
        kind: 'planning',
        planningSessionId: 'plan-alpha',
        data: 'ALPHA_TMUX_VISIBLE\n',
      });
    });
    expect(xtermMock.writeLog.filter((entry) => entry === 'ALPHA_TMUX_VISIBLE\n')).toHaveLength(1);

    fireEvent.click(within(screen.getByTestId('planning-session-list')).getByRole('button', { name: /Beta tmux session/ }));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', 'term-beta');
    });
    await act(async () => {
      mock.fireTerminalOutput({
        sessionId: 'term-beta',
        taskId: 'planning:plan-beta',
        kind: 'planning',
        planningSessionId: 'plan-beta',
        data: 'BETA_TMUX_VISIBLE\n',
      });
    });
    expect(xtermMock.writeLog.filter((entry) => entry === 'BETA_TMUX_VISIBLE\n')).toHaveLength(1);

    fireEvent.click(within(screen.getByTestId('planning-session-list')).getByRole('button', { name: /Alpha tmux session/ }));

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', 'term-alpha');
      expect(xtermMock.writeLog.filter((entry) => entry === 'ALPHA_TMUX_VISIBLE\n')).toHaveLength(2);
    });
  });

  it('does not trust an unconfirmed terminal status as live, and reattaches for real when asked', async () => {
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'plan-ambiguous',
          title: 'Ambiguous tmux session',
          status: 'still_discussing',
          draftPlanAvailable: false,
          terminalMode: 'tmux',
          terminalSessionId: 'term-ambiguous',
          terminalOutputSnapshot: 'stale snapshot from before restart',
        }),
      ],
    })) as any;

    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-home'));

    expect(await screen.findByTestId('invoker-terminal-tmux-placeholder')).toBeInTheDocument();
    expect(screen.queryByTestId('invoker-terminal-tmux-pane')).not.toBeInTheDocument();
    expect(mock.api.planningTerminalOpen).not.toHaveBeenCalled();

    fireEvent.click(within(screen.getByTestId('invoker-terminal-mode-toggle')).getByRole('tab', { name: 'Tmux' }));

    await waitFor(() => expect(mock.api.planningTerminalOpen).toHaveBeenCalledWith('plan-ambiguous'));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute(
        'data-session-id',
        'mock-planning-terminal-plan-ambiguous',
      );
    });
  });

  it('renders chat role labels and fenced YAML in a mono code panel', async () => {
    mock.api.planningChatSend = vi.fn(async () => ({
      ok: true,
      sessionId: 'session-1',
      reply: 'I drafted the plan.\n\n```yaml\nname: Fence Plan\ntasks: []\n```',
      draftPlanAvailable: true,
      draftPlanSummary: { name: 'Fence Plan', taskCount: 0, taskGroups: [] },
    })) as any;

    render(<App />);
    await openPlanningTerminal();
    submitPlanningText('draft it');

    const transcript = await screen.findByTestId('invoker-terminal-transcript');
    await waitFor(() => {
      expect(transcript).toHaveTextContent('I drafted the plan.');
      expect(transcript).toHaveTextContent('name: Fence Plan');
    });
    expect(transcript).toHaveTextContent('You');
    expect(transcript).toHaveTextContent('Invoker');
    expect(transcript.querySelector('pre code')).toBeTruthy();
    expect(transcript.querySelector('pre')?.className ?? '').toContain('font-mono');
    expect(screen.queryByText('you ›')).not.toBeInTheDocument();
    expect(screen.queryByText('invoker ›')).not.toBeInTheDocument();
  });

  it('does not render reasoning details when a response includes reasoning', async () => {
    mock.api.planningChatSend = vi.fn(async () => ({
      ok: true,
      sessionId: 'session-1',
      reply: 'Hello. What should we plan?',
      reasoning: 'Greet the user and ask what to plan.',
      draftPlanAvailable: false,
    })) as any;

    render(<App />);
    await openPlanningTerminal();
    submitPlanningText('hello');

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Hello. What should we plan?');
    });
    expect(screen.queryByTestId('invoker-terminal-thinking')).not.toBeInTheDocument();
    expect(screen.queryByText('Greet the user and ask what to plan.')).not.toBeInTheDocument();
    expect(screen.queryByText('thread.started')).not.toBeInTheDocument();
  });

  it('sends plain language when Enter is pressed', async () => {
    render(<App />);
    await openPlanningTerminal();

    const input = screen.getByTestId('invoker-terminal-input');
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledWith({ message: 'hello', presetKey: 'codex', confirmationMode: 'require' });
    });
  });

  it('never shows the wait cursor while a planning request is busy', async () => {
    let resolveSend: ((value: any) => void) | null = null;
    mock.api.planningChatSend = vi.fn(() => {
      return new Promise((resolve) => {
        resolveSend = resolve;
      }) as any;
    }) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('draft a plan');

    const input = screen.getByTestId('invoker-terminal-input');
    await waitFor(() => expect(input).toBeDisabled());
    expect(input).toHaveClass('disabled:cursor-not-allowed');
    expect(input).not.toHaveClass('disabled:cursor-wait');

    await act(async () => {
      resolveSend?.({ ok: true, sessionId: 'session-1', reply: 'Done.', draftPlanAvailable: false });
    });
  });

  it('reports planning chat input, submit, and transcript render perf markers', async () => {
    const props = {
      activeConversationKey: 'chat-1',
      lines: [{ id: 1, text: 'First line', role: 'system' as const }],
      busy: false,
      value: '',
      selectedPresetKey: 'codex',
      presetOptions: [{ key: 'codex', label: 'Codex', tool: 'codex' }],
      selectedConfirmationMode: 'require' as const,
      draftPlanAvailable: false,
      onValueChange: vi.fn(),
      onSubmit: vi.fn(),
      onSubmitDraft: vi.fn(),
      onPresetChange: vi.fn(),
      onConfirmationModeChange: vi.fn(),
      onExpand: vi.fn(),
    };
    const { rerender } = render(<InvokerTerminal {...props} />);
    vi.mocked(mock.api.reportUiPerf).mockClear();

    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: 'hello' } });
    expect(mock.api.reportUiPerf).toHaveBeenCalledWith(
      'planning_chat_input_change',
      expect.objectContaining({
        valueLength: 5,
        previousValueLength: 0,
        deltaLength: 5,
        conversationKey: 'chat-1',
        transcriptLineCount: 1,
      }),
    );

    rerender(<InvokerTerminal {...props} value="hello" />);
    await waitFor(() => {
      expect(mock.api.reportUiPerf).toHaveBeenCalledWith(
        'planning_chat_input_commit',
        expect.objectContaining({
          valueLength: 5,
          previousValueLength: 0,
          deltaLength: 5,
          conversationKey: 'chat-1',
          transcriptLineCount: 1,
        }),
      );
    });

    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
    expect(mock.api.reportUiPerf).toHaveBeenCalledWith(
      'planning_chat_submit',
      expect.objectContaining({
        source: 'form',
        valueLength: 5,
        trimmedLength: 5,
        conversationKey: 'chat-1',
      }),
    );

    rerender(<InvokerTerminal
      {...props}
      value="hello"
      lines={[...props.lines, { id: 2, text: 'Second line', role: 'assistant' as const }]}
    />);
    await waitFor(() => {
      expect(mock.api.reportUiPerf).toHaveBeenCalledWith(
        'planning_chat_transcript_commit',
        expect.objectContaining({
          conversationKey: 'chat-1',
          lineCount: 2,
          lineDelta: 1,
          transcriptChars: 'First lineSecond line'.length,
          lastLineRole: 'assistant',
        }),
      );
    });
  });

  it('keeps typing responsive under a large existing transcript', async () => {
    const largeTranscript = Array.from({ length: 360 }, (_, index) => ({
      id: index + 1,
      text: `pressure transcript line ${index + 1}: ${'renderer output '.repeat(12)}`,
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
    }));

    function Harness(): JSX.Element {
      const [value, setValue] = useState('');
      return (
        <InvokerTerminal
          activeConversationKey="large-chat"
          lines={largeTranscript}
          busy={false}
          value={value}
          selectedPresetKey="codex"
          presetOptions={[{ key: 'codex', label: 'Codex', tool: 'codex' }]}
          selectedConfirmationMode="require"
          draftPlanAvailable={false}
          onValueChange={setValue}
          onSubmit={vi.fn()}
          onSubmitDraft={vi.fn()}
          onPresetChange={vi.fn()}
          onConfirmationModeChange={vi.fn()}
          onExpand={vi.fn()}
        />
      );
    }

    render(<Harness />);
    vi.mocked(mock.api.reportUiPerf).mockClear();

    const nextValue = 'tighten terminal responsiveness assertions';
    const input = screen.getByTestId('invoker-terminal-input');
    fireEvent.change(input, { target: { value: nextValue } });

    await waitFor(() => expect(input).toHaveValue(nextValue));
    await waitFor(() => {
      expect(mock.api.reportUiPerf).toHaveBeenCalledWith(
        'planning_chat_input_commit',
        expect.objectContaining({
          valueLength: nextValue.length,
          previousValueLength: 0,
          conversationKey: 'large-chat',
          transcriptLineCount: largeTranscript.length,
        }),
      );
    });

    const changePayload = lastPerfPayload('planning_chat_input_change');
    expect(changePayload.handlerDurationMs).toBeLessThanOrEqual(COMPONENT_INPUT_HANDLER_BUDGET_MS);
    expect(changePayload.transcriptLineCount).toBe(largeTranscript.length);

    const commitPayload = lastPerfPayload('planning_chat_input_commit');
    expect(Number.isFinite(commitPayload.durationMs)).toBe(true);
    expect(commitPayload.durationMs).toBeGreaterThanOrEqual(0);
    expect(commitPayload.transcriptLineCount).toBe(largeTranscript.length);

    const transcriptCommitsAfterTyping = vi.mocked(mock.api.reportUiPerf).mock.calls
      .filter(([metric]) => metric === 'planning_chat_transcript_commit');
    expect(transcriptCommitsAfterTyping).toHaveLength(0);
  });

  it('reports a many-workflow planning typing lag baseline from the task prompt editor', async () => {
    const { tasks, workflows } = makeManyWorkflowTypingBaseline();
    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-planning'));

    act(() => mock.setTasks(tasks, workflows));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-chat-0')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('workflow-node-wf-chat-0'));

    const promptTaskNode = await screen.findByTestId('rf__node-wf-chat-0/message-00');
    expect(promptTaskNode).toBeInTheDocument();
    fireEvent.click(promptTaskNode);

    await waitFor(() => {
      expect(screen.getByTestId('prompt-command-display')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('prompt-command-display'));

    const promptInput = await screen.findByTestId('edit-prompt-input') as HTMLTextAreaElement;
    const reportUiPerf = vi.mocked(mock.api.reportUiPerf);
    reportUiPerf.mockClear();

    const nextPrompt = `${promptInput.value}\noperator typed follow-up`;
    fireEvent.change(promptInput, { target: { value: nextPrompt } });

    await waitFor(() => {
      expect(reportUiPerf.mock.calls.some(([metric]) => metric === 'planning_typing_lag_baseline')).toBe(true);
    });

    const payload = lastPerfPayload('planning_typing_lag_baseline');
    expect(payload).toEqual(expect.objectContaining({
      scenario: 'many-chats-many-messages-typing',
      sessionCount: workflows.length,
      transcriptMessageCount: expectedTranscriptMessageCount(tasks),
      taskCount: tasks.length,
      workflowCount: workflows.length,
      taskStatusCounts: { pending: tasks.length },
      activeSurface: 'planning',
      activeState: 'dag:task_selected:terminal-minimized',
      viewMode: 'dag',
      terminalDrawerState: 'minimized',
      selectionState: 'task_selected',
      selectedTaskId: 'wf-chat-0/message-00',
      selectedWorkflowId: 'wf-chat-0',
      targetName: 'edit-prompt-input',
      targetTagName: 'textarea',
      targetValueLength: nextPrompt.length,
      targetReadOnly: false,
      targetDisabled: false,
      targetIsComposing: false,
      eventType: 'change',
      lagMs: expect.any(Number),
    }));
    expect(payload.transcriptSizeBytes).toBeGreaterThan(10_000);
  }, 10_000);

  it('hydrates restored planning chats and keeps the restored session editable', async () => {
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'saved-pressure-chat',
          title: 'Saved pressure chat',
          status: 'still_discussing',
          presetKey: 'codex',
          messages: [
            {
              id: 1,
              role: 'system',
              text: 'Ask Invoker what you want to build.',
              tone: 'muted',
              createdAt: '2026-07-07T00:00:00.000Z',
            },
            {
              id: 2,
              role: 'user',
              text: 'Keep this restored transcript editable',
              createdAt: '2026-07-07T00:00:01.000Z',
            },
            {
              id: 3,
              role: 'assistant',
              text: 'The restored transcript is ready.',
              createdAt: '2026-07-07T00:00:02.000Z',
            },
          ],
          draftPlanAvailable: false,
        }),
      ],
    }));

    render(<App />);
    await openPlanningTerminal();

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('The restored transcript is ready.');
    });
    expect(screen.getByTestId('invoker-terminal-input')).toBeEnabled();

    submitPlanningText('continue the restored session');

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledWith({
        sessionId: 'saved-pressure-chat',
        message: 'continue the restored session',
        presetKey: 'codex',
        confirmationMode: 'require',
      });
    });
  });

  it('counts only attention-worthy planning sessions in the sidebar badge', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true });
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'idle-chat',
          title: 'Idle chat',
          status: 'still_discussing',
          draftPlanAvailable: false,
        }),
        makePlanningSessionSummary({
          id: 'draft-chat',
          title: 'Draft ready chat',
          status: 'draft_ready',
          draftPlanAvailable: true,
        }),
        makePlanningSessionSummary({
          id: 'waiting-chat',
          title: 'Waiting chat',
          status: 'waiting_for_answer',
          draftPlanAvailable: false,
        }),
        makePlanningSessionSummary({
          id: 'submitted-chat',
          title: 'Submitted chat',
          status: 'submitted',
          draftPlanAvailable: false,
        }),
      ],
    }));

    render(<App />);

    const homeButton = await screen.findByTestId('sidebar-home');
    await waitFor(() => {
      expect(within(homeButton).getByText('2')).toBeInTheDocument();
    });

    fireEvent.click(homeButton);
    expect(screen.getByTestId('planning-session-rail')).toHaveTextContent('4 chats');
  });

  it('keeps the Planning Terminal attention count unchanged when creating an idle chat', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true });
    render(<App />);

    const homeButton = await screen.findByTestId('sidebar-home');
    expect(within(homeButton).queryByText('0')).not.toBeInTheDocument();

    fireEvent.click(homeButton);
    expect(screen.getByTestId('planning-session-rail')).toHaveTextContent('1 chat');
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));

    await waitFor(() => expect(screen.getByTestId('planning-session-rail')).toHaveTextContent('2 chats'));
    expect(within(screen.getByTestId('sidebar-home')).queryByText('0')).not.toBeInTheDocument();
    expect(screen.getByTestId('planning-session-rail')).toHaveTextContent('2 chats');
  });

  it('deletes a saved planning chat from its row trash button', async () => {
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makeRailPlanningSession('delete-saved-chat', 'Delete saved chat'),
        makeRailPlanningSession('keep-saved-chat', 'Keep saved chat'),
      ],
    }));

    render(<App />);
    await openPlanningTerminal();

    const rail = screen.getByTestId('planning-session-list');
    await waitFor(() => expect(within(rail).getAllByText('Delete saved chat').length).toBeGreaterThan(0));

    fireEvent.click(within(getPlanningSessionRowByText('Delete saved chat')).getByRole('button', { name: 'Delete planning chat' }));

    await waitFor(() => {
      expect(within(rail).queryByText('Delete saved chat')).not.toBeInTheDocument();
    });
    expect(within(rail).getAllByText('Keep saved chat').length).toBeGreaterThan(0);
    expect(mock.api.planningChatDelete).toHaveBeenCalledWith({ sessionId: 'delete-saved-chat' });
  });

  it('deletes a local planning chat without calling planningChatDelete', async () => {
    mock.api.planningChatSend = vi.fn(() => new Promise(() => {}) as any) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('local unsaved planning chat');
    await waitFor(() => expect(mock.api.planningChatSend).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    fireEvent.click(within(getPlanningSessionRowByText('local unsaved planning chat')).getByRole('button', { name: 'Delete planning chat' }));

    await waitFor(() => {
      expect(within(screen.getByTestId('planning-session-list')).queryByText('local unsaved planning chat')).not.toBeInTheDocument();
    });
    expect(mock.api.planningChatDelete).not.toHaveBeenCalled();
  });

  it('disables Clear submitted when there are no submitted planning chats', async () => {
    render(<App />);
    await openPlanningTerminal();

    const clearButton = screen.getByRole('button', { name: 'Clear submitted' });
    expect(clearButton).toBeDisabled();

    fireEvent.click(clearButton);
    expect(mock.api.planningChatDeleteSubmitted).not.toHaveBeenCalled();
  });

  it('clears all submitted planning chats after confirmation', async () => {
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makeRailPlanningSession('active-chat', 'Active chat'),
        makeRailPlanningSession('submitted-chat-1', 'Submitted one', 'submitted'),
        makeRailPlanningSession('submitted-chat-2', 'Submitted two', 'submitted'),
      ],
    }));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    try {
      render(<App />);
      await openPlanningTerminal();

      const rail = screen.getByTestId('planning-session-list');
      await waitFor(() => expect(within(rail).getAllByText('Submitted one').length).toBeGreaterThan(0));
      const clearButton = screen.getByRole('button', { name: 'Clear submitted' });
      expect(clearButton).toBeEnabled();

      fireEvent.click(clearButton);

      await waitFor(() => {
        expect(within(rail).queryByText('Submitted one')).not.toBeInTheDocument();
        expect(within(rail).queryByText('Submitted two')).not.toBeInTheDocument();
      });
      expect(within(rail).getAllByText('Active chat').length).toBeGreaterThan(0);
      expect(screen.getByTestId('planning-session-rail')).toHaveTextContent('1 chat');
      expect(screen.getByRole('button', { name: 'Clear submitted' })).toBeDisabled();
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(mock.api.planningChatDeleteSubmitted).toHaveBeenCalledTimes(1);
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it('recreates a fresh empty chat after deleting the last planning chat', async () => {
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makeRailPlanningSession('only-saved-chat', 'Only saved chat'),
      ],
    }));

    render(<App />);
    await openPlanningTerminal();

    await waitFor(() => expect(screen.getByTestId('planning-session-list')).toHaveTextContent('Only saved chat'));
    fireEvent.click(within(getPlanningSessionRowByText('Only saved chat')).getByRole('button', { name: 'Delete planning chat' }));

    await waitFor(() => {
      expect(within(screen.getByTestId('planning-session-list')).queryByText('Only saved chat')).not.toBeInTheDocument();
      expect(screen.getByText('What do you want to build?')).toBeInTheDocument();
    });
    expect(screen.getByTestId('planning-session-rail')).toHaveTextContent('1 chat');
    expect(screen.getByTestId('invoker-terminal-input')).toBeEnabled();
    expect(mock.api.planningChatDelete).toHaveBeenCalledWith({ sessionId: 'only-saved-chat' });
  });

  it('hides planning chat trash buttons and disables Clear submitted in read-only mode', async () => {
    mock.setRuntimeStatus({
      ownerMode: false,
      readOnly: true,
      mode: 'read-only',
    });
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makeRailPlanningSession('readonly-active-chat', 'Readonly active chat'),
        makeRailPlanningSession('readonly-submitted-chat', 'Readonly submitted chat', 'submitted'),
      ],
    }));
    mock.install();

    render(<App />);
    await openPlanningTerminal();

    await waitFor(() => expect(screen.getByTestId('invoker-terminal-input')).toBeDisabled());
    expect(screen.queryByRole('button', { name: 'Delete planning chat' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear submitted' })).toBeDisabled();
  });

  it('continues the same planning session', async () => {
    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('hello');
    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledTimes(1);
    });

    submitPlanningText('make the plan more detailed');

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenLastCalledWith({
        sessionId: 'session-1',
        message: 'make the plan more detailed',
        presetKey: 'codex',
        confirmationMode: 'require',
      });
    });
  });

  it('shows a lost-session error instead of starting a fresh chat for local transcript continuation', async () => {
    mock.api.planningChatSend = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: 'planner failed before creating a server session',
      })
      .mockResolvedValueOnce({
        ok: true,
        sessionId: 'session-2',
        reply: 'What do you want to build?',
        draftPlanAvailable: false,
      }) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('draft a plan that fails before a session exists');
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('planner failed before creating a server session');
    });

    submitPlanningText('continue without losing context');

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent(
        'This planning chat lost its server session. Start a new chat to continue planning.',
      );
    });
    expect(mock.api.planningChatSend).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('invoker-terminal-transcript')).not.toHaveTextContent('What do you want to build?');
  });

  it('passes the selected planning preset', async () => {
    render(<App />);
    await openPlanningTerminal();

    fireEvent.change(screen.getByTestId('invoker-terminal-harness'), { target: { value: 'omp' } });
    await waitFor(() => expect(screen.getByTestId('invoker-terminal-model')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('invoker-terminal-model'), { target: { value: 'omp+claude' } });
    submitPlanningText('draft a plan');

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledWith({ message: 'draft a plan', presetKey: 'omp+claude', confirmationMode: 'require' });
    });
  });

  it('sends typed submit as a draft request before a draft is ready', async () => {
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'session-1',
          title: 'No draft chat',
          status: 'still_discussing',
          messages: [
            {
              id: 1,
              role: 'user',
              text: 'I need a plan.',
              createdAt: '2026-07-07T00:00:01.000Z',
            },
            {
              id: 2,
              role: 'assistant',
              text: 'What should the plan include?',
              createdAt: '2026-07-07T00:00:02.000Z',
            },
          ],
          draftPlanAvailable: false,
          draftPlanSummary: undefined,
          draftPlanText: undefined,
        }),
      ],
    }));

    render(<App />);
    await openPlanningTerminal();

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('What should the plan include?');
    });

    submitPlanningText('submit');

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledWith({
        sessionId: 'session-1',
        message: 'submit',
        presetKey: 'codex',
        confirmationMode: 'require',
      });
    });
    expect(mock.api.planningChatSubmit).not.toHaveBeenCalled();
    expect(mock.api.startReady).not.toHaveBeenCalled();
  });

  it('does not offer auto-submit in conversational planning', async () => {
    render(<App />);
    await openPlanningTerminal();

    expect(screen.queryByRole('option', { name: 'Auto-submit' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Ask first' })).toBeInTheDocument();
  });

  it('shows the bound repo and short commit sha in the planning context sidebar', async () => {
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'repo-bound-session',
          title: 'Repo bound chat',
          status: 'still_discussing',
          draftPlanAvailable: false,
          draftPlanSummary: undefined,
          repoUrl: 'https://github.com/Neko-Catpital-Labs/Invoker.git',
          baseBranch: 'main',
          baseCommit: 'a1b2c3d4e5f6',
        }),
      ],
    })) as any;

    render(<App />);
    await openPlanningTerminal();
    fireEvent.click(screen.getByTestId('planning-context-toggle'));

    const repoStatus = await screen.findByTestId('planning-repo-status');
    expect(repoStatus).toHaveTextContent('Neko-Catpital-Labs/Invoker @ a1b2c3d');
  });

  it('shows "No repository bound yet" when the planning session has no repo bound', async () => {
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'no-repo-session',
          title: 'No repo chat',
          status: 'still_discussing',
          draftPlanAvailable: false,
          draftPlanSummary: undefined,
          repoUrl: undefined,
          baseBranch: undefined,
          baseCommit: undefined,
        }),
      ],
    })) as any;

    render(<App />);
    await openPlanningTerminal();
    fireEvent.click(screen.getByTestId('planning-context-toggle'));

    const repoStatus = await screen.findByTestId('planning-repo-status');
    expect(repoStatus).toHaveTextContent('No repository bound yet');
  });

  it('shows a locked-draft note in the sidebar while reviewing a draft', async () => {
    mock.api.planningChatSend = vi.fn(async () => ({
      ok: true,
      sessionId: 'session-1',
      reply: 'Here is the plan.',
      draftPlanAvailable: true,
      draftPlanSummary: { name: 'Mock Plan', taskCount: 2, steps: ['First', 'Second'] },
      draftPlanText: 'name: Mock Plan\ntasks: []\n',
    })) as any;
    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('draft the full plan');

    expect(await screen.findByTestId('planning-draft-locked-note')).toHaveTextContent(
      'This draft is locked — critique in chat, or ask Invoker to re-draft, to change it.',
    );
  });

  it('submits a draft and starts ready work when the user types submit', async () => {
    mock.api.planningChatSend = vi.fn(async () => ({
      ok: true,
      sessionId: 'session-1',
      reply: 'Here is the plan.',
      draftPlanAvailable: true,
      draftPlanSummary: { name: 'Mock Plan', taskCount: 2, steps: ['First', 'Second'] },
    })) as any;
    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('draft the full plan');

    await screen.findByTestId('planning-create-workflow');
    expect(screen.queryByTestId('invoker-terminal-ready-bar')).not.toBeInTheDocument();

    expect(mock.api.planningChatSubmit).not.toHaveBeenCalled();
    expect(mock.api.startReady).not.toHaveBeenCalled();

    submitPlanningText('submit');
    await waitFor(() => {
      expect(mock.api.planningChatSubmit).toHaveBeenCalledWith({ sessionId: 'session-1' });
      expect(mock.api.refreshTaskGraph).toHaveBeenCalled();
      expect(mock.api.startReady).toHaveBeenCalledWith({});
    });
    fireEvent.click(screen.getByTestId('sidebar-home'));
    expect(screen.getByRole('heading', { name: 'Planning chat' })).toBeInTheDocument();
    expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Plan "Mock Plan" submitted to Invoker. No ready work to start.');
    expect(screen.queryByRole('heading', { name: 'Plan graph' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoker-terminal-ready-bar')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit to Invoker' })).not.toBeInTheDocument();
    expect(mock.api.start).not.toHaveBeenCalled();
  });

  it('shows stacked workflow counts before creating the workflow', async () => {
    mock.api.planningChatSend = vi.fn(async () => ({
      ok: true,
      sessionId: 'session-1',
      reply: 'Here is the plan.',
      draftPlanAvailable: true,
      draftPlanSummary: {
        name: 'Workers Surface',
        taskCount: 4,
        workflowCount: 2,
        steps: ['Workers Surface Contracts', 'Workers Surface UI'],
        taskGroups: [
          { workflow: 'Workers Surface Contracts', tasks: ['Review claim: Define contracts\nReview lane: behavior\nSafety invariant: Preserve existing behavior.', 'Verify contracts'] },
          { workflow: 'Workers Surface UI', tasks: ['Build UI', 'Verify UI'] },
        ],
      },
    })) as any;
    mock.api.planningChatSubmit = vi.fn(async () => ({
      ok: true,
      planName: 'Workers Surface',
      workflowId: 'wf-2',
      workflowIds: ['wf-1', 'wf-2'],
      workflowCount: 2,
    })) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('draft the Workers Surface plan');

    await screen.findByTestId('planning-create-workflow');
    expect(screen.queryByTestId('invoker-terminal-ready-bar')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('draft-task-group')).toHaveLength(2);
    const multilineDescription = screen.getAllByTestId('draft-step-summary')[0];
    expect(multilineDescription).toHaveClass('whitespace-pre-wrap');
    expect(multilineDescription).toHaveTextContent('Review claim: Define contracts Review lane: behavior Safety invariant: Preserve existing behavior.');
    expect(multilineDescription.textContent).toBe('Review claim: Define contracts\nReview lane: behavior\nSafety invariant: Preserve existing behavior.');
    fireEvent.click(screen.getByTestId('planning-create-workflow'));

    await waitFor(() => {
      expect(mock.api.planningChatSubmit).toHaveBeenCalledWith({ sessionId: 'session-1' });
      expect(mock.api.refreshTaskGraph).toHaveBeenCalled();
      expect(mock.api.startReady).toHaveBeenCalledWith({});
    });
    fireEvent.click(screen.getByTestId('sidebar-home'));
    expect(screen.getByRole('heading', { name: 'Planning chat' })).toBeInTheDocument();
    expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent(
      'Plan "Workers Surface" submitted as 2 stacked workflows. No ready work to start.',
    );
    expect(screen.queryByRole('heading', { name: 'Plan graph' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoker-terminal-ready-bar')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit to Invoker' })).not.toBeInTheDocument();
  });

  it('keeps a draft reviewable when workflow creation fails', async () => {
    const submitError = 'Task "make-selected-lists-scroll" uses "autoFix", which is no longer supported.';
    mock.api.planningChatSend = vi.fn(async () => ({
      ok: true,
      sessionId: 'session-1',
      reply: 'Here is the plan.',
      draftPlanAvailable: true,
      draftPlanSummary: { name: 'Selected lists scroll', taskCount: 4, steps: ['First', 'Second', 'Third', 'Fourth'] },
    })) as any;
    mock.api.planningChatSubmit = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: submitError })
      .mockResolvedValueOnce({ ok: true, planName: 'Selected lists scroll', workflowId: 'wf-1' }) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('draft the full plan');
    await screen.findByTestId('planning-create-workflow');
    expect(screen.queryByTestId('invoker-terminal-ready-bar')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('planning-create-workflow'));

    expect(screen.getByTestId('planning-create-workflow')).toBeInTheDocument();
    expect(mock.api.refreshTaskGraph).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('planning-create-workflow'));

    await waitFor(() => {
      expect(mock.api.planningChatSubmit).toHaveBeenCalledTimes(2);
      expect(mock.api.refreshTaskGraph).toHaveBeenCalled();
      expect(mock.api.startReady).toHaveBeenCalledWith({});
    });
    fireEvent.click(screen.getByTestId('sidebar-home'));
    expect(screen.getByRole('heading', { name: 'Planning chat' })).toBeInTheDocument();
    expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Plan "Selected lists scroll" submitted to Invoker. No ready work to start.');
    expect(screen.queryByRole('heading', { name: 'Plan graph' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoker-terminal-ready-bar')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit to Invoker' })).not.toBeInTheDocument();
  });

  it('surfaces a planner failure in the transcript before a draft exists', async () => {
    const plannerError = 'agent exited 0 but produced no output after 3 attempts — stderr tail: cursor: session expired; run `cursor login` to re-authenticate';
    mock.api.planningChatSend = vi.fn(async () => ({ ok: false, sessionId: 'session-1', error: plannerError })) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('Draft me an Invoker plan');

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent(plannerError);
    });
    expect(screen.queryByTestId('invoker-terminal-ready-bar')).not.toBeInTheDocument();
  });

  it('explains that run needs a submitted plan first', async () => {
    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('run');

    expect(await screen.findByText('Create or submit a plan before starting ready work.')).toBeInTheDocument();
    expect(mock.api.startReady).not.toHaveBeenCalled();
    expect(mock.api.start).not.toHaveBeenCalled();
  });

  it('marks a submitted planning session read-only', async () => {
    mock.api.planningChatSend = vi.fn(async () => ({
      ok: true,
      sessionId: 'session-1',
      reply: 'Here is the plan.',
      draftPlanAvailable: true,
      draftPlanSummary: { name: 'Mock Plan', taskCount: 2, steps: ['First', 'Second'] },
    })) as any;
    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('draft the full plan');
    await screen.findByTestId('planning-create-workflow');
    expect(screen.queryByTestId('invoker-terminal-ready-bar')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('planning-create-workflow'));
    await waitFor(() => expect(mock.api.planningChatSubmit).toHaveBeenCalledWith({ sessionId: 'session-1' }));

    fireEvent.click(screen.getByTestId('sidebar-home'));

    const input = screen.getByTestId('invoker-terminal-input');
    expect(input).toBeDisabled();
    expect(input).toHaveClass('disabled:cursor-not-allowed');
    expect(input).not.toHaveClass('disabled:cursor-wait');
    expect(screen.getAllByText(/submitted/i).length).toBeGreaterThan(0);
  });

  it('shows a running workflow dot only for submitted planning sessions whose workflow is still running', async () => {
    const workflows: WorkflowMeta[] = [
      { id: 'wf-running', name: 'Running workflow', status: 'running' },
      { id: 'wf-completed', name: 'Completed workflow', status: 'completed' },
    ];
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'submitted-running-chat',
          title: 'Submitted running chat',
          status: 'submitted',
          draftPlanAvailable: false,
          draftPlanSummary: undefined,
          draftPlanText: undefined,
          submittedWorkflowId: 'wf-running',
          submittedPlanName: 'Running workflow plan',
        }),
        makePlanningSessionSummary({
          id: 'submitted-completed-chat',
          title: 'Submitted completed chat',
          status: 'submitted',
          draftPlanAvailable: false,
          draftPlanSummary: undefined,
          draftPlanText: undefined,
          submittedWorkflowId: 'wf-completed',
          submittedPlanName: 'Completed workflow plan',
        }),
      ],
    })) as any;
    mock.setTasks([], workflows);

    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-home'));

    const runningRow = getPlanningSessionRowByText('Submitted running chat');
    const completedRow = getPlanningSessionRowByText('Submitted completed chat');

    expect(within(runningRow).getByLabelText('Workflow running')).toHaveClass('bg-primary');
    expect(within(completedRow).queryByLabelText('Workflow running')).not.toBeInTheDocument();
  });

  it('opens the graph from a submitted planning chat by restoring the saved viewport instead of fitting', async () => {
    const savedViewport = { x: -444, y: 156, zoom: 0.71 };
    const workflows: WorkflowMeta[] = [{ id: 'wf-submitted', name: 'Submitted workflow', status: 'running' }];
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'submitted-chat',
          title: 'Submitted viewport chat',
          status: 'submitted',
          draftPlanAvailable: false,
          draftPlanSummary: undefined,
          draftPlanText: undefined,
          submittedWorkflowId: 'wf-submitted',
          submittedPlanName: 'Submitted viewport plan',
        }),
      ],
    })) as any;
    mock.setTasks([], workflows);

    render(<App />);

    fireEvent.click(await screen.findByTestId('sidebar-planning'));
    await screen.findByTestId('workflow-node-wf-submitted');
    await settleCamera();
    getViewportMock.mockReturnValue(savedViewport);

    fireEvent.click(screen.getByTestId('sidebar-home'));
    await waitFor(() => expect(screen.getByTestId('invoker-terminal-submitted-bar')).toHaveTextContent('Submitted viewport plan'));

    fitViewMock.mockClear();
    setCenterMock.mockClear();
    setViewportMock.mockClear();
    workflowGraphSpy.reset();

    fireEvent.click(screen.getByTestId('invoker-terminal-open-graph'));

    await waitFor(() => expect(screen.getByTestId('workflow-node-wf-submitted')).toBeInTheDocument());
    await waitFor(() => expect(setViewportMock).toHaveBeenCalledWith(savedViewport, { duration: 0 }));
    await flushFrames(4);

    expect(fitViewMock).not.toHaveBeenCalled();
    expect(setCenterMock).not.toHaveBeenCalled();
    expect(workflowGraphSpy.commands.some((command) => (
      command?.kind === 'fitInitial'
      && command.scope === 'workflow'
      && command.reason === 'planning-open-graph'
    ))).toBe(false);
  });

  it('opens the expanded planning chat and Escape closes it without clearing transcript', async () => {
    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('hello');
    await waitFor(() => expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('I can help draft that.'));

    fireEvent.click(screen.getByRole('button', { name: 'Expand planning chat' }));
    expect(screen.getByTestId('invoker-terminal-expanded')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByTestId('invoker-terminal-expanded')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('I can help draft that.');
  });

  it('creates another planning chat without clearing the first transcript', async () => {
    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('hello');
    await waitFor(() => expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('I can help draft that.'));

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));

    expect(screen.getByTestId('invoker-terminal-input')).toHaveValue('');
    expect(screen.getByTestId('invoker-terminal-transcript')).not.toHaveTextContent('I can help draft that.');

    fireEvent.click(screen.getByText('hello'));

    expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('I can help draft that.');
  });

  it('wraps long planning session rail titles and previews instead of clipping them to one line', async () => {
    const longPrompt = 'Draft a very long planning session title that needs multiple readable wrapped lines in the fixed planning rail';
    const longReply = [
      'This planning preview should remain readable in the rail with several wrapped words,',
      'including implementation details, verification notes, and follow-up context that used to be hidden by truncate.',
    ].join(' ');
    mock.api.planningChatSend = vi.fn(async () => ({
      ok: true,
      sessionId: 'session-1',
      reply: longReply,
      draftPlanAvailable: false,
    })) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText(longPrompt);

    const rail = screen.getByTestId('planning-session-list');
    await waitFor(() => {
      expect(within(rail).getByText(longReply)).toBeInTheDocument();
    });

    const expectedTitle = `${longPrompt.slice(0, 53).trimEnd()}…`;
    const title = within(rail).getByText(expectedTitle);
    const preview = within(rail).getByText(longReply);
    expect(title).toHaveClass('line-clamp-2', 'min-w-0', 'flex-1', 'break-words', 'leading-5');
    expect(title).not.toHaveClass('truncate');
    expect(title).toHaveAttribute('title', expectedTitle);
    expect(preview).toHaveClass('mt-1', 'line-clamp-3', 'break-words');
    expect(preview).not.toHaveClass('truncate');
    expect(preview).toHaveAttribute('title', longReply);
    expect(screen.getByTestId('planning-session-rail')).toHaveClass('w-64', 'shrink-0');
  });

  it('keeps a new planning chat editable while another session is working', async () => {
    let resolveFirstSend: ((value: any) => void) | null = null;
    mock.api.planningChatSend = vi.fn((request: any) => {
      if (!request.sessionId) {
        return new Promise((resolve) => {
          resolveFirstSend = resolve;
        }) as any;
      }
      return Promise.resolve({
        ok: true,
        sessionId: request.sessionId,
        reply: 'Second session is ready.',
        draftPlanAvailable: false,
      }) as any;
    }) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('first session request');
    await waitFor(() => expect(mock.api.planningChatSend).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));

    const secondInput = screen.getByTestId('invoker-terminal-input');
    expect(secondInput).not.toBeDisabled();
    fireEvent.change(secondInput, { target: { value: 'second session request' } });
    expect(secondInput).toHaveValue('second session request');

    resolveFirstSend?.({
      ok: true,
      sessionId: 'session-1',
      reply: 'First session is ready.',
      draftPlanAvailable: false,
    });
    await waitFor(() => expect(screen.getByTestId('invoker-terminal-input')).toHaveValue('second session request'));
  });

  it('auto-follows a new assistant reply when the transcript is near the bottom', async () => {
    const props = terminalProps();
    const { rerender } = render(<InvokerTerminal {...props} />);
    const transcript = screen.getByTestId('invoker-terminal-transcript');
    Object.defineProperty(transcript, 'clientHeight', { configurable: true, value: 100 });
    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 400 });

    transcript.scrollTop = 268;
    fireEvent.scroll(transcript);
    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 500 });
    rerender(<InvokerTerminal {...props} lines={[...props.lines, { id: 2, text: 'Second line', role: 'assistant' as const }]} />);

    await waitFor(() => expect(transcript.scrollTop).toBe(500));
  });

  it('does not force-scroll after the user scrolls away from the bottom', async () => {
    const props = terminalProps({
      lines: [
        { id: 1, text: 'First line', role: 'system' as const },
        { id: 2, text: 'Second line', role: 'assistant' as const },
      ],
    });
    const { rerender } = render(<InvokerTerminal {...props} />);
    const transcript = screen.getByTestId('invoker-terminal-transcript');
    Object.defineProperty(transcript, 'clientHeight', { configurable: true, value: 100 });
    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 500 });

    transcript.scrollTop = 50;
    fireEvent.scroll(transcript);
    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 600 });
    rerender(<InvokerTerminal {...props} lines={[
      ...props.lines,
      { id: 3, text: 'Third line', role: 'assistant' as const },
    ]} />);

    await waitFor(() => expect(screen.getByText('Third line')).toBeInTheDocument());
    expect(transcript.scrollTop).toBe(50);
  });

  it('resets transcript follow mode when the active planning conversation changes', async () => {
    const props = terminalProps({
      lines: [{ id: 1, text: 'First chat', role: 'system' as const }],
    });
    const { rerender } = render(<InvokerTerminal {...props} />);
    const transcript = screen.getByTestId('invoker-terminal-transcript');
    Object.defineProperty(transcript, 'clientHeight', { configurable: true, value: 100 });
    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 400 });

    transcript.scrollTop = 50;
    fireEvent.scroll(transcript);
    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 500 });
    const nextProps = terminalProps({
      activeConversationKey: 'chat-2',
      lines: [{ id: 2, text: 'Second chat', role: 'system' as const }],
    });
    rerender(<InvokerTerminal {...nextProps} />);

    await waitFor(() => expect(transcript.scrollTop).toBe(500));

    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 600 });
    rerender(<InvokerTerminal
      {...nextProps}
      lines={[...nextProps.lines, { id: 3, text: 'Second chat reply', role: 'assistant' as const }]}
    />);

    await waitFor(() => expect(transcript.scrollTop).toBe(600));
  });

  it('constrains left rail lists to bounded scroll regions', async () => {
    const workflows: WorkflowMeta[] = [
      { id: 'wf-alpha', name: 'Alpha', status: 'running' },
      { id: 'wf-beta', name: 'Beta', status: 'failed' },
    ];
    const tasks = [
      makeUITask({
        id: 'wf-alpha/running-task',
        description: 'Running rail task',
        status: 'running',
        workflowId: 'wf-alpha',
        command: 'echo running',
      }),
      makeUITask({
        id: 'wf-beta/attention-task',
        description: 'Attention rail task',
        status: 'failed',
        workflowId: 'wf-beta',
        command: 'echo failed',
      }),
    ];

    mock.cleanup();
    mock = createMockInvoker(tasks, workflows);
    mock.install();
    render(<App />);
    await screen.findByTestId('planning-session-list');

    await expectSurfaceRailList('home', 'planning-session-list');
    await expectSurfaceRailList('workflows', 'workflows-rail-list');
    await expectSurfaceRailList('attention', 'attention-rail-list');
    expect(screen.queryByTestId('running-rail-list')).not.toBeInTheDocument();
  }, 15_000);

  it('keeps the submit button accessible as Send while rendering an icon-only affordance', () => {
    render(<InvokerTerminal {...terminalProps({ value: 'draft a plan' })} />);

    const sendButton = screen.getByRole('button', { name: 'Send' });
    expect(sendButton).toBeEnabled();
    expect(sendButton).not.toHaveTextContent('Send');
    expect(within(sendButton).getByTestId('invoker-terminal-send-icon')).toBeInTheDocument();
  });

  it('uses the amber send-button styling in the enabled state', () => {
    render(<InvokerTerminal {...terminalProps({ value: 'draft a plan' })} />);

    const sendButton = screen.getByRole('button', { name: 'Send' });
    expect(sendButton).toHaveClass('bg-amber-400');
    expect(sendButton).toHaveClass('text-white');
    expect(sendButton).toHaveClass('hover:bg-amber-300');
  });

  it('keeps the icon-only Send button disabled for empty input, busy state, and read-only sessions', () => {
    const { rerender } = render(<InvokerTerminal {...terminalProps({ value: '' })} />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    rerender(<InvokerTerminal {...terminalProps({ busy: true, value: 'draft a plan' })} />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    rerender(<InvokerTerminal {...terminalProps({ readOnly: true, value: 'draft a plan' })} />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });
});

function submitContextWorkflow(id: string, name = id): WorkflowMeta {
  return {
    id,
    name,
    status: 'pending',
  };
}

describe('Invoker terminal submit context (component)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker(
      [makeUITask({ id: 'task-a', workflowId: 'workflow-a', description: 'Initial task' })],
      [submitContextWorkflow('workflow-a', 'Initial Plan')],
    );
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
    vi.restoreAllMocks();
  });

  function stubSubmitStyleRefresh() {
    const nextTasks = [
      makeUITask({ id: 'task-a', workflowId: 'workflow-a', description: 'Initial task' }),
      makeUITask({ id: 'task-b', workflowId: 'workflow-b', description: 'Submitted planning task' }),
    ];
    const nextWorkflows = [
      submitContextWorkflow('workflow-a', 'Initial Plan'),
      submitContextWorkflow('workflow-b', 'Submitted Plan'),
    ];
    vi.mocked(mock.api.refreshTaskGraph).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          queueMicrotask(() => {
            mock.fireGraphEvent({
              type: 'snapshot',
              tasks: nextTasks,
              workflows: nextWorkflows,
              reason: 'submit-style-refresh',
              streamSequence: 1,
            });
            resolve();
          });
        }),
    );
  }

  it('preserves a cleared graph selection when submit-style refresh adds a workflow', async () => {
    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-planning'));

    expect(await screen.findByTestId('workflow-node-workflow-a')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('selected-workflow-mini-dag')).toBeInTheDocument();
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      fireEvent.click(await screen.findByTestId('rf__node-task-a'));
      await waitFor(() => {
        expect(
          screen
            .getByTestId('selected-workflow-mini-dag')
            .querySelector('[data-keyboard-region="taskGraph"]'),
        ).toHaveAttribute('data-keyboard-active', 'true');
      });
      await flushFrames(2);

      fireEvent.keyDown(document, { key: 'Escape' });
      await flushFrames(2);

      if (screen.queryByTestId('selected-workflow-mini-dag') === null) break;
    }

    await waitFor(() => {
      expect(screen.queryByTestId('selected-workflow-mini-dag')).not.toBeInTheDocument();
    });

    stubSubmitStyleRefresh();
    fireEvent.click(screen.getByTestId('rail-refresh'));

    expect(await screen.findByTestId('workflow-node-workflow-b')).toBeInTheDocument();
    expect(screen.queryByTestId('selected-workflow-mini-dag')).not.toBeInTheDocument();
    expect(screen.getByTestId('workflow-node-workflow-a').className).not.toContain('ring-2');
    expect(screen.getByTestId('workflow-node-workflow-b').className).not.toContain('ring-2');
    expect(mock.api.start).not.toHaveBeenCalled();
  });

  it('keeps an existing workflow selection stable across submit-style refresh', async () => {
    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-planning'));

    expect(await screen.findByTestId('workflow-node-workflow-a')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('workflow-node-workflow-a'));

    await waitFor(() => {
      expect(screen.getByTestId('selected-workflow-mini-dag')).toBeInTheDocument();
    });

    stubSubmitStyleRefresh();
    fireEvent.click(screen.getByTestId('rail-refresh'));

    expect(await screen.findByTestId('workflow-node-workflow-b')).toBeInTheDocument();
    expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Initial Plan task DAG');
    expect(screen.getByTestId('workflow-node-workflow-a').className).toContain('ring-2');
    expect(screen.getByTestId('workflow-node-workflow-b').className).not.toContain('ring-2');
    expect(mock.api.start).not.toHaveBeenCalled();
  });
});
