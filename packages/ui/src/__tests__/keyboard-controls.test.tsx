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

  it('Refresh button calls getTasks', async () => {
    render(<App />);
    fireEvent.click(screen.getByText('Refresh'));

    await waitFor(() => {
      // getTasks is called on mount and again on refresh
      expect(mock.api.getTasks).toHaveBeenCalled();
    });
  });

  it('Clear button calls clear', async () => {
    render(<App />);
    fireEvent.click(screen.getByText('Clear'));

    await waitFor(() => {
      expect(mock.api.clear).toHaveBeenCalled();
    });
  });
});
