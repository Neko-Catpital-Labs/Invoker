/**
 * Component test: TopBar controls (Refresh, Clear).
 *
 * Demoted from packages/app/e2e/keyboard-controls.spec.ts.
 * Dropped: Ctrl+Backtick terminal toggle, terminal toggle bar (Electron shell features).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

describe('TopBar controls (component)', () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Utility menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Refresh' }));

    await waitFor(() => {
      expect(mock.api.getTasks).toHaveBeenCalled();
      expect(mock.api.getTasks).toHaveBeenLastCalledWith(true);
    });
  });

  it('Clear button calls clear', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Utility menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear Session' }));

    await waitFor(() => {
      expect(mock.api.clear).toHaveBeenCalled();
    });
  });
});
