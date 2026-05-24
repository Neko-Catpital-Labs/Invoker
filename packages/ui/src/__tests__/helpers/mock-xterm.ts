/**
 * Mock the xterm and xterm-addon-fit modules for jsdom component tests.
 *
 * Real xterm requires `HTMLCanvasElement.getContext`, which jsdom does not
 * implement, so production code falls into its try/catch and never writes to
 * the terminal. Tests that need to assert what was written use this mock to
 * substitute a minimal Terminal/FitAddon pair with vitest spies.
 *
 * Usage in tests:
 *   vi.mock('xterm', async () => {
 *     const { createXtermModule } = await import('./helpers/mock-xterm.js');
 *     return createXtermModule();
 *   });
 *   vi.mock('xterm-addon-fit', async () => {
 *     const { createFitAddonModule } = await import('./helpers/mock-xterm.js');
 *     return createFitAddonModule();
 *   });
 *   // ... render component ...
 *   expect(xtermMockState.instances[0].write).toHaveBeenCalledWith('snapshot');
 */

import { vi } from 'vitest';

export interface MockTerminal {
  cols: number;
  rows: number;
  open: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  loadAddon: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
}

export interface MockFitAddon {
  fit: ReturnType<typeof vi.fn>;
}

interface XtermMockState {
  instances: MockTerminal[];
}

export const xtermMockState: XtermMockState = {
  instances: [],
};

export function resetXtermMocks(): void {
  xtermMockState.instances = [];
}

function makeMockTerminal(): MockTerminal {
  return {
    cols: 80,
    rows: 24,
    open: vi.fn(),
    write: vi.fn(),
    loadAddon: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
  };
}

export function createXtermModule() {
  return {
    Terminal: vi.fn(() => {
      const term = makeMockTerminal();
      xtermMockState.instances.push(term);
      return term;
    }),
  };
}

export function createFitAddonModule() {
  return {
    FitAddon: vi.fn(
      (): MockFitAddon => ({
        fit: vi.fn(),
      }),
    ),
  };
}
