/**
 * Component test: App launch and initial state.
 *
 * Demoted from packages/app/e2e/app-launch.spec.ts.
 * Tests UI rendering in empty state (no plan loaded).
 * Dropped: window title (Electron main process), terminal toggle (Electron shell).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi } from 'vitest';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

// Lazy import App after mocking @xyflow/react
const { App } = await import('../App.js');

describe('App launch (component)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('shows empty state prompt when no plan is loaded', () => {
    render(<App />);
    expect(screen.getByText('Load a plan to get started')).toBeInTheDocument();
  });

  it('renders Open File and utility dropdown with Refresh, Clear Session, Delete DB, and System Setup', () => {
    render(<App />);

    // Open File is always visible
    expect(screen.getByText('Open File')).toBeInTheDocument();

    // Refresh, Clear, Delete DB are now inside the dropdown
    expect(screen.queryByText('Refresh')).not.toBeInTheDocument();
    expect(screen.queryByText('Clear Session')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete Workflow History (DB)')).not.toBeInTheDocument();

    // Click the ellipsis button to open the dropdown
    const utilityButton = screen.getByLabelText('Utility menu');
    fireEvent.click(utilityButton);

    // Now the items should be visible
    expect(screen.getByText('Refresh')).toBeInTheDocument();
    expect(screen.getByText('Clear Session')).toBeInTheDocument();
    expect(screen.getByText('Delete Workflow History (DB)')).toBeInTheDocument();

    // Also check for disabled placeholder items
    expect(screen.getByText('Export Logs...')).toBeInTheDocument();
    expect(screen.getByText('System Setup...')).toBeInTheDocument();
  });

  it('does not show Start or Stop before a plan is loaded', () => {
    render(<App />);
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
  });

  it('StatusBar renders with Total count', () => {
    render(<App />);
    expect(screen.getByText('Total:')).toBeInTheDocument();
  });

  it('TaskPanel shows selection prompt', () => {
    render(<App />);
    expect(screen.getByText('Select a task from the graph to view details')).toBeInTheDocument();
  });

  it('opens System Setup automatically when packaged bundled skills need installation', async () => {
    mock.api.getSystemDiagnostics = vi.fn(async () => ({
      platform: 'linux',
      arch: 'x64',
      appVersion: '0.0.1',
      isPackaged: true,
      tools: [],
      bundledSkills: {
        available: true,
        promptRecommended: true,
        managedPrefix: 'invoker-',
        bundledSkillNames: ['plan-to-invoker'],
        targets: [
          {
            id: 'codex',
            name: 'Codex',
            path: '/tmp/.codex/skills',
            available: true,
            installed: false,
            upToDate: false,
            installedSkillNames: [],
          },
          {
            id: 'claude',
            name: 'Claude',
            path: '/tmp/.claude/skills',
            available: true,
            installed: false,
            upToDate: false,
            installedSkillNames: [],
          },
          {
            id: 'cursor',
            name: 'Cursor',
            path: '/tmp/.cursor/skills-cursor',
            available: true,
            installed: false,
            upToDate: false,
            installedSkillNames: [],
          },
        ],
      },
    }));

    render(<App />);
    expect(await screen.findByText('System Setup')).toBeInTheDocument();
    expect(screen.getByText('Bundled Invoker Skills')).toBeInTheDocument();
    expect(screen.getByText('Install Skills')).toBeInTheDocument();
    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(screen.getByText('Cursor')).toBeInTheDocument();
  });
});
