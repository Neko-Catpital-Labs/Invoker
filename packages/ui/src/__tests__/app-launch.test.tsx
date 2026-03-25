/**
 * Component test: App launch and initial state.
 *
 * Demoted from packages/app/e2e/app-launch.spec.ts.
 * Tests UI rendering in empty state (no plan loaded).
 * Dropped: window title (Electron main process), terminal toggle (Electron shell).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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

  it('renders Open File, Refresh, Clear, and Delete DB buttons', () => {
    render(<App />);
    expect(screen.getByText('Open File')).toBeInTheDocument();
    expect(screen.getByText('Refresh')).toBeInTheDocument();
    expect(screen.getByText('Clear')).toBeInTheDocument();
    expect(screen.getByText('Delete DB')).toBeInTheDocument();
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
});
