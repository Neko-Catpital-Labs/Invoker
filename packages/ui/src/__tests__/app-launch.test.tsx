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
    expect(screen.getByText('Load a plan to render workflow graph')).toBeInTheDocument();
  });

  it('renders left rail navigation and workflow controls', () => {
    render(<App />);
    expect(screen.getByTestId('rail-open-file')).toBeInTheDocument();
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

  it('opens system setup from left rail settings', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('rail-settings'));
    expect(await screen.findByText('System Setup')).toBeInTheDocument();
  });
});
