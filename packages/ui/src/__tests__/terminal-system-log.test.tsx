/**
 * Component test: System Activity Log button visibility.
 *
 * Demoted from packages/app/e2e/terminal-system-log.spec.ts.
 * Dropped: xterm rendering, IPC activity logs (Electron-only features).
 * Only 1 of 4 E2E tests translates: System Log button visibility.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

describe('System Activity Log (component)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('System Log button is visible in status bar', () => {
    render(<App />);
    expect(screen.getByText('System Log')).toBeInTheDocument();
  });
});
