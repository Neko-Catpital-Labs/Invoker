/**
 * Mock `xterm` and `xterm-addon-fit` for jsdom component tests.
 *
 * The real Terminal needs a DOM with canvas + ResizeObserver to instantiate;
 * the production `TerminalDrawer` wraps construction in a try/catch so missing
 * environment just falls through. That makes it invisible to assertions that
 * need to inspect what the renderer wrote into the terminal — e.g. the
 * embedded replay snapshot seeding path. This mock keeps an in-module list of
 * created instances so tests can grab the spy on `write`.
 *
 * Usage in tests:
 *   vi.mock('xterm', async () => {
 *     const { createXTermMock } = await import('./helpers/mock-xterm.js');
 *     return createXTermMock();
 *   });
 *   vi.mock('xterm-addon-fit', async () => {
 *     const { createFitAddonMock } = await import('./helpers/mock-xterm.js');
 *     return createFitAddonMock();
 *   });
 */

import { vi } from 'vitest';

export interface MockTerminalInstance {
  write: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
  loadAddon: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  cols: number;
  rows: number;
}

const terminalInstances: MockTerminalInstance[] = [];

class MockTerminal implements MockTerminalInstance {
  write = vi.fn();
  open = vi.fn();
  loadAddon = vi.fn();
  onData = vi.fn(() => ({ dispose: vi.fn() }));
  focus = vi.fn();
  dispose = vi.fn();
  cols = 80;
  rows = 24;

  constructor() {
    terminalInstances.push(this);
  }
}

class MockFitAddon {
  fit = vi.fn();
  dispose = vi.fn();
  activate = vi.fn();
}

export function createXTermMock() {
  return { Terminal: MockTerminal };
}

export function createFitAddonMock() {
  return { FitAddon: MockFitAddon };
}

export function getMockTerminalInstances(): MockTerminalInstance[] {
  return terminalInstances;
}

export function resetMockTerminalInstances(): void {
  terminalInstances.length = 0;
}
