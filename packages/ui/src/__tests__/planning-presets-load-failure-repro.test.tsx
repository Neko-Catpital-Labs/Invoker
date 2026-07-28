import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

describe('planning presets load failure repro', () => {
  let mock: MockInvoker;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    mock.cleanup();
  });

  it('logs the underlying error instead of silently falling back to Codex only', async () => {
    const loadError = new Error('boom: getPlanningPresets IPC failed');
    mock.api.getPlanningPresets = vi.fn(async () => {
      throw loadError;
    }) as any;

    render(<App />);

    await waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to load planning presets', loadError);
    });
  });
});
