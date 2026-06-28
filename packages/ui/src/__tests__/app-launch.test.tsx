/**
 * Component test: App launch and initial state.
 *
 * Demoted from packages/app/e2e/app-launch.spec.ts.
 * Tests UI rendering in empty state (no plan loaded).
 * Dropped: window title (Electron main process), terminal toggle (Electron shell).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { vi } from 'vitest';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

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
