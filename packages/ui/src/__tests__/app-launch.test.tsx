/**
 * Component test: App launch and initial state.
 *
 * Demoted from packages/app/e2e/app-launch.spec.ts.
 * Tests UI rendering in empty state (no plan loaded).
 * Dropped: window title (Electron main process), terminal toggle (Electron shell).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
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
    vi.clearAllTimers();
    vi.useRealTimers();
    cleanup();
    mock.cleanup();
    vi.restoreAllMocks();
  });
  it('shows the reskinned empty shell when no plan is loaded', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true });
    render(<App />);
    act(() => window.dispatchEvent(new Event('resize')));
    expect(await screen.findByText('Plan graph')).toBeInTheDocument();
    expect(screen.queryByText('What do you want to build?')).not.toBeInTheDocument();
    expect(screen.getByText('What to expect')).toBeInTheDocument();
    expect(screen.getAllByText('Your plan will appear here.').length).toBeGreaterThan(0);
    expect(screen.getByTestId('sidebar-home')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-planning')).toHaveTextContent('Planning Terminal');
    expect(screen.getByTestId('sidebar-workflows')).toHaveTextContent('Workflows');
    expect(screen.getByTestId('sidebar-attention')).toHaveTextContent('Needs Attention');
    expect(screen.getByTestId('sidebar-running')).toHaveTextContent('Running');
    expect(screen.getByTestId('sidebar-workers')).toHaveTextContent('Workers');
  });

  it('hides the collapsed Planning Terminal badge for the idle initial chat', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });

    render(<App />);
    act(() => window.dispatchEvent(new Event('resize')));
    await screen.findByTestId('sidebar-planning');

    fireEvent.click(screen.getByTestId('sidebar-collapse-toggle'));

    const sidebar = screen.getByTestId('app-sidebar');
    expect(sidebar.className).toContain('w-16');
    expect(screen.getByTestId('sidebar-planning').textContent).toBe('');

    Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true });
  });

  it('opens read-only worker status from the left panel', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true });
    act(() => window.dispatchEvent(new Event('resize')));
    mock.setWorkerStatus({
      generatedAt: '2026-01-01T00:00:00.000Z',
      workers: [
        {
          kind: 'pr-status',
          note: 'PR status',
          source: 'built-in',
          availability: 'available',
          running: true,
          lifecycle: 'running',
          policy: 'enabled',
          autoStarts: true,
          startable: false,
          stoppable: true,
          runtimeKind: 'pr-status',
          recentActions: [
            {
              id: 'action-1',
              workerKind: 'pr-status',
              actionType: 'check-pr',
              subjectType: 'workflow',
              subjectId: 'wf-1',
              externalKey: 'wf-1',
              status: 'completed',
              attemptCount: 1,
              summary: 'Checked PR status',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:01:00.000Z',
            },
          ],
          recentLogs: [
            {
              id: 'log-1',
              workerKind: 'pr-status',
              source: 'worker_actions',
              actionType: 'check-pr',
              subjectType: 'workflow',
              subjectId: 'wf-1',
              status: 'completed',
              summary: 'PR check finished',
              createdAt: '2026-01-01T00:01:00.000Z',
            },
          ],
        },
        {
          kind: 'autofix',
          note: 'Autofix worker',
          source: 'built-in',
          availability: 'available',
          lifecycle: 'stopped',
          policy: 'enabled',
          autoStarts: false,
          startable: true,
          stoppable: false,
          recentActions: [],
          recentLogs: [],
        },
      ],
    });

    render(<App />);

    const workersButton = await screen.findByTestId('sidebar-workers');
    expect(workersButton).toHaveTextContent('Workers');
    fireEvent.click(workersButton);

    expect(await screen.findByTestId('worker-activity-card')).toBeInTheDocument();
    expect(screen.getAllByText('PR status').length).toBeGreaterThan(0);
    expect(screen.getByText('Autofix worker')).toBeInTheDocument();
    expect(screen.getAllByText('Source: Built In').length).toBeGreaterThan(0);
    expect(screen.getByText('Checked PR status')).toBeInTheDocument();
    expect(screen.getByText('PR check finished')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start process' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop process' })).not.toBeInTheDocument();
  });
  it('renders the Apple-like source list without manual plan loading', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true });
    render(<App />);
    act(() => window.dispatchEvent(new Event('resize')));
    expect(await screen.findByTestId('sidebar-home')).toHaveTextContent('Invoker');
    expect(screen.queryByTestId('rail-open-file')).not.toBeInTheDocument();
    expect(screen.getByTestId('rail-settings')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-planning')).toHaveTextContent('Planning Terminal');
    expect(screen.getByTestId('sidebar-workflows')).toHaveTextContent('Workflows');
    expect(screen.getByTestId('sidebar-attention')).toHaveTextContent('Needs Attention');
    expect(screen.getByTestId('sidebar-running')).toHaveTextContent('Running');
    expect(screen.getByTestId('sidebar-workers')).toHaveTextContent('Workers');
    expect(screen.queryByRole('button', { name: 'Home' })).not.toBeInTheDocument();
  });

  it('returns home when Invoker is selected at the top', async () => {
    const workflows: WorkflowMeta[] = [
      { id: 'wf-alpha', name: 'Alpha', status: 'running' },
    ];
    const alpha = makeUITask({ id: 'task-alpha', description: 'First test task', status: 'running', workflowId: 'wf-alpha' });

    render(<App />);
    act(() => mock.setTasks([alpha], workflows));

    fireEvent.click(await screen.findByTestId('sidebar-workflows'));
    expect(await screen.findByText('1 workflow')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('sidebar-home'));
    expect(await screen.findByText('Plan graph')).toBeInTheDocument();
    expect(screen.getByText('Alpha · running')).toBeInTheDocument();
  });
  it('keeps sidebar width under explicit toggle control while surfaces change', async () => {
    render(<App />);
    await screen.findByTestId('sidebar-workflows');

    expect(screen.getByTestId('app-sidebar').className).toContain('w-60');

    fireEvent.click(screen.getByTestId('sidebar-workflows'));
    expect(await screen.findByTestId('browser-rail')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Workflows' })).toBeInTheDocument();
    expect(screen.getByTestId('app-sidebar').className).toContain('w-60');

    fireEvent.click(screen.getByTestId('browser-rail-dismiss'));
    expect(await screen.findByText('Plan graph')).toBeInTheDocument();
    expect(screen.getByTestId('app-sidebar').className).toContain('w-60');

    fireEvent.click(screen.getByTestId('sidebar-collapse-toggle'));
    expect(screen.getByTestId('app-sidebar').className).toContain('w-16');

    fireEvent.click(screen.getByTestId('sidebar-planning'));
    expect(await screen.findByTestId('planning-session-rail')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Planning Terminal' })).toBeInTheDocument();
    expect(screen.getByTestId('app-sidebar').className).toContain('w-16');

    fireEvent.click(screen.getByTestId('sidebar-attention'));
    expect(await screen.findByTestId('browser-rail')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Needs Attention' })).toBeInTheDocument();
    expect(screen.getByTestId('app-sidebar').className).toContain('w-16');

    fireEvent.click(screen.getByTestId('sidebar-workers'));
    expect(await screen.findByTestId('workers-rail')).toBeInTheDocument();
    expect(screen.getByTestId('app-sidebar').className).toContain('w-16');

    fireEvent.click(screen.getByTestId('sidebar-home'));
    expect(await screen.findByText('Plan graph')).toBeInTheDocument();
    expect(screen.getByTestId('app-sidebar').className).toContain('w-16');

    fireEvent.click(screen.getByTestId('sidebar-collapse-toggle'));
    expect(screen.getByTestId('app-sidebar').className).toContain('w-60');
  });
  it('keeps the manual app sidebar width while switching left rail surfaces', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true });

    render(<App />);
    await screen.findByTestId('sidebar-workflows');

    const sidebar = screen.getByTestId('app-sidebar');
    const toggle = screen.getByTestId('sidebar-collapse-toggle');

    fireEvent.click(toggle);
    expect(sidebar.className).toContain('w-16');
    expect(screen.getByTestId('sidebar-running')).toBeInTheDocument();

    for (const surface of ['workflows', 'attention', 'workers', 'planning', 'home']) {
      fireEvent.click(screen.getByTestId(`sidebar-${surface}`));
      expect(sidebar.className).toContain('w-16');
    }
    fireEvent.click(screen.getByTestId('sidebar-workflows'));
    expect(await screen.findByTestId('browser-rail')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('browser-return-home'));
    expect(sidebar.className).toContain('w-16');

    fireEvent.click(toggle);
    expect(sidebar.className).toContain('w-60');

    for (const surface of ['workflows', 'attention', 'workers', 'planning', 'home']) {
      fireEvent.click(screen.getByTestId(`sidebar-${surface}`));
      expect(sidebar.className).toContain('w-60');
    }
    fireEvent.click(screen.getByTestId('sidebar-workflows'));
    expect(await screen.findByTestId('browser-rail')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('browser-rail-dismiss'));
    expect(sidebar.className).toContain('w-60');
  });

  it('does not show the running browser rail on workers', async () => {
    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-workers'));
    expect(screen.queryByTestId('browser-rail')).not.toBeInTheDocument();
    expect(screen.queryByTestId('running-rail-list')).not.toBeInTheDocument();
    expect(screen.getByTestId('workers-rail')).toBeInTheDocument();
  });


  it('shows workflow status chips and terminal drawer controls in home view', () => {
    render(<App />);
    expect(screen.getByTestId('workflow-status-pill-running')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Partial terminal drawer' })).toBeInTheDocument();
  });

  it('requests runtime status for read-only windows', async () => {
    mock.api.getRuntimeStatus = vi.fn(async () => ({
      ownerMode: false,
      readOnly: true,
      mode: 'read-only',
    }));

    await act(async () => {
      render(<App />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mock.api.getRuntimeStatus).toHaveBeenCalled();
    expect(screen.getByTestId('read-only-mode-banner')).toBeInTheDocument();
  });

  it('hides the read-only banner for the local write owner', async () => {
    render(<App />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByTestId('read-only-mode-banner')).not.toBeInTheDocument();
  });

  it('shows the connection-lost banner when runtime status flips after owner loss', async () => {
    render(<App />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId('connection-lost-banner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('read-only-mode-banner')).not.toBeInTheDocument();

    await act(async () => {
      mock.fireRuntimeStatus({
        ownerMode: false,
        readOnly: true,
        mode: 'connection-lost',
      });
    });

    expect(screen.getByTestId('connection-lost-banner')).toBeInTheDocument();
    expect(screen.getByTestId('connection-lost-banner')).toHaveTextContent('Connection lost.');
    expect(screen.queryByTestId('read-only-mode-banner')).not.toBeInTheDocument();
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
