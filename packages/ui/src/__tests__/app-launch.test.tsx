/**
 * Component test: App launch and initial state.
 *
 * Demoted from packages/app/e2e/app-launch.spec.ts.
 * Tests UI rendering in empty state (no plan loaded).
 * Dropped: window title (Electron main process), terminal toggle (Electron shell).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  // Dynamic import is required because Vitest hoists mock factories before test imports.
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

// Dynamic import is required so App sees the hoisted @xyflow/react mock.
const { App } = await import('../App.js');

describe('App launch (component)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    vi.useRealTimers();
    mock.cleanup();
  });

  it('shows empty state prompt when no plan is loaded', () => {
    render(<App />);
    expect(screen.getByTestId('workflow-empty-state')).toBeInTheDocument();
    expect(screen.getByText('Drive Invoker from a goal')).toBeInTheDocument();
    expect(screen.getByText('plan "Fix a failing test"')).toBeInTheDocument();
    expect(screen.getByTestId('collapsible-guide-toggle')).toHaveTextContent('First-run guide');

    fireEvent.click(screen.getByTestId('collapsible-guide-toggle'));
    expect(screen.getByText('Review the plan graph before starting a workflow.')).toBeInTheDocument();
  });

  it('renders left rail navigation and workflow controls', () => {
    const { container } = render(<App />);
    expect(screen.getByTestId('rail-open-file')).toBeInTheDocument();
    expect(screen.getByTestId('rail-open-file')).toHaveTextContent('Open Plan');
    expect(screen.getByTestId('rail-open-file')).toHaveAttribute('title', 'Open a YAML or JSON Invoker plan file');
    expect(container.querySelector('input[type="file"]')).toHaveAttribute('accept', '.json,.yaml,.yml');
    expect(screen.getByTestId('rail-home')).toBeInTheDocument();
    expect(screen.getByTestId('rail-timeline')).toBeInTheDocument();
    expect(screen.getByTestId('rail-history')).toBeInTheDocument();
    expect(screen.getByTestId('rail-queue')).toBeInTheDocument();
    expect(screen.queryByTestId('rail-attention')).not.toBeInTheDocument();
    expect(screen.getByTestId('rail-refresh')).toBeInTheDocument();
    expect(screen.getByTestId('rail-clear')).toBeInTheDocument();
  });

  it('shows workflow status chips and terminal drawer controls in home view', () => {
    render(<App />);
    expect(screen.getByTestId('workflow-status-pill-running')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Partial terminal drawer' })).toBeInTheDocument();
  });

  it('opens a focused run surface from the workflow graph', async () => {
    const workflow: WorkflowMeta = {
      id: 'wf-focus',
      name: 'Focused run demo',
      status: 'running',
      baseBranch: 'master',
    };
    mock.setTasks([
      makeUITask({
        id: 'wf-focus/plan',
        description: 'Create plan',
        workflowId: 'wf-focus',
        status: 'completed',
        command: 'echo plan',
      }),
      makeUITask({
        id: 'wf-focus/approve',
        description: 'Approve migration',
        workflowId: 'wf-focus',
        status: 'awaiting_approval',
        dependencies: ['wf-focus/plan'],
        command: 'echo approve',
      }),
    ], [workflow]);

    render(<App />);
    fireEvent.click(await screen.findByTestId('workflow-node-wf-focus'));
    await waitFor(() => {
      expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Approve migration');
    });

    const focusedSurface = await screen.findByTestId('focused-workflow-surface');
    expect(focusedSurface).toBeInTheDocument();
    expect(within(focusedSurface).getByRole('heading', { name: 'Focused run demo' })).toBeInTheDocument();
    expect(within(focusedSurface).getAllByText('Approve migration').length).toBeGreaterThan(0);
    expect(within(focusedSurface).getByText('Local task graph')).toBeInTheDocument();
    expect(screen.getByTestId('selected-workflow-mini-dag')).toBeInTheDocument();
    expect(screen.getByTestId('collapsible-guide-toggle')).toHaveTextContent('Run guide');

    fireEvent.click(screen.getByTestId('focused-workflow-back'));
    expect(screen.queryByTestId('focused-workflow-surface')).not.toBeInTheDocument();
    expect(screen.getByTestId('workflow-node-wf-focus')).toBeInTheDocument();
  });

  it('counts all attention tasks while showing only the focused run shortlist', async () => {
    const workflow: WorkflowMeta = {
      id: 'wf-attention',
      name: 'Attention run',
      status: 'needs_input',
      baseBranch: 'master',
    };
    const attentionTasks = Array.from({ length: 5 }, (_, index) => makeUITask({
      id: `wf-attention/task-${index + 1}`,
      description: `Needs attention ${index + 1}`,
      workflowId: 'wf-attention',
      status: 'awaiting_approval',
      command: `echo ${index + 1}`,
    }));
    mock.setTasks(attentionTasks, [workflow]);

    render(<App />);
    fireEvent.click(await screen.findByTestId('workflow-node-wf-attention'));

    const focusedSurface = await screen.findByTestId('focused-workflow-surface');
    await waitFor(() => {
      const attentionLabel = within(focusedSurface).getAllByText('Needs attention')[0];
      expect(within(attentionLabel.parentElement as HTMLElement).getByText('5')).toBeInTheDocument();
      expect(within(focusedSurface).getByText('Needs attention 4')).toBeInTheDocument();
      expect(within(focusedSurface).queryByText('Needs attention 5')).not.toBeInTheDocument();
    });
  });

  it('keeps first workflow auto-selection after empty-state actions', async () => {
    render(<App />);

    const emptyState = await screen.findByTestId('workflow-empty-state');
    fireEvent.click(within(emptyState).getByRole('button', { name: 'Open Plan' }));

    const workflow: WorkflowMeta = {
      id: 'wf-arriving',
      name: 'Arriving workflow',
      status: 'running',
      baseBranch: 'master',
    };
    mock.setTasks([
      makeUITask({
        id: 'wf-arriving/task-1',
        description: 'Arriving task',
        workflowId: 'wf-arriving',
        command: 'echo arriving',
      }),
    ], [workflow]);

    await waitFor(() => {
      expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Arriving task');
    });
  });

  it('warns when no Claude or Codex CLI is installed', async () => {
    mock.api.getSystemDiagnostics = vi.fn(async () => ({
      platform: 'darwin',
      arch: 'arm64',
      appVersion: '0.0.5',
      isPackaged: true,
      tools: [
        { id: 'claude', name: 'Claude', required: false, installed: false, installHint: 'Install Claude CLI' },
        { id: 'codex', name: 'Codex', required: false, installed: false, installHint: 'Install Codex CLI' },
      ],
      bundledSkills: {
        available: true,
        promptRecommended: false,
        managedPrefix: 'invoker-',
        bundledSkillNames: ['plan-to-invoker'],
        targets: [],
        commandTargets: [],
        mcpTargets: [],
      },
    }));

    render(<App />);

    expect(await screen.findByText('No Claude or Codex CLI detected yet. Install one before running agent-backed execution tasks.')).toBeInTheDocument();
  });

  it('opens system setup from left rail settings', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('rail-settings'));
    expect(await screen.findByText('System Setup')).toBeInTheDocument();
  });

  it('delays the automatic bundled helper setup prompt', async () => {
    vi.useFakeTimers();
    mock.api.getSystemDiagnostics = vi.fn(async () => ({
      platform: 'darwin',
      arch: 'arm64',
      appVersion: '0.0.5',
      isPackaged: true,
      tools: [
        { id: 'codex', name: 'Codex', required: false, installed: true, installHint: 'Installed' },
      ],
      bundledSkills: {
        available: true,
        promptRecommended: true,
        managedPrefix: 'invoker-',
        bundledSkillNames: ['plan-to-invoker'],
        targets: [],
        commandTargets: [
          { id: 'omp', name: 'OMP', path: '/tmp/.omp/agent/commands', available: true, installed: false, upToDate: false, installedCommandNames: [] },
        ],
        mcpTargets: [
          { id: 'omp', name: 'OMP', path: '/tmp/.omp/agent/mcp.json', available: true, installed: false, upToDate: false, serverName: 'invoker' },
        ],
      },
    }));

    render(<App />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText(/Invoker AI helpers are ready/)).toBeInTheDocument();
    expect(screen.queryByText('System Setup')).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1199);
    });
    expect(screen.queryByText('System Setup')).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByText('System Setup')).toBeInTheDocument();
  });

  it('cancels the automatic bundled helper setup prompt when dismissed', async () => {
    vi.useFakeTimers();
    mock.api.getSystemDiagnostics = vi.fn(async () => ({
      platform: 'darwin',
      arch: 'arm64',
      appVersion: '0.0.5',
      isPackaged: true,
      tools: [
        { id: 'codex', name: 'Codex', required: false, installed: true, installHint: 'Installed' },
      ],
      bundledSkills: {
        available: true,
        promptRecommended: true,
        managedPrefix: 'invoker-',
        bundledSkillNames: ['plan-to-invoker'],
        targets: [],
        commandTargets: [
          { id: 'omp', name: 'OMP', path: '/tmp/.omp/agent/commands', available: true, installed: false, upToDate: false, installedCommandNames: [] },
        ],
        mcpTargets: [
          { id: 'omp', name: 'OMP', path: '/tmp/.omp/agent/mcp.json', available: true, installed: false, upToDate: false, serverName: 'invoker' },
        ],
      },
    }));

    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });

    expect(screen.queryByText('System Setup')).not.toBeInTheDocument();
  });

  it('cancels the automatic bundled helper setup prompt after manual setup close', async () => {
    vi.useFakeTimers();
    mock.api.getSystemDiagnostics = vi.fn(async () => ({
      platform: 'darwin',
      arch: 'arm64',
      appVersion: '0.0.5',
      isPackaged: true,
      tools: [
        { id: 'codex', name: 'Codex', required: false, installed: true, installHint: 'Installed' },
      ],
      bundledSkills: {
        available: true,
        promptRecommended: true,
        managedPrefix: 'invoker-',
        bundledSkillNames: ['plan-to-invoker'],
        targets: [],
        commandTargets: [
          { id: 'omp', name: 'OMP', path: '/tmp/.omp/agent/commands', available: true, installed: false, upToDate: false, installedCommandNames: [] },
        ],
        mcpTargets: [
          { id: 'omp', name: 'OMP', path: '/tmp/.omp/agent/mcp.json', available: true, installed: false, upToDate: false, serverName: 'invoker' },
        ],
      },
    }));

    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open Setup' }));
    expect(screen.getByText('System Setup')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });

    expect(screen.queryByText('System Setup')).not.toBeInTheDocument();
  });
});
