/**
 * xterm mock for jsdom-based component tests.
 *
 * Real xterm requires HTMLCanvasElement.getContext, which jsdom does not
 * implement. This factory returns Vitest mocks for `xterm` and
 * `xterm-addon-fit` so the drawer pane can be exercised without a canvas
 * backing, and exposes the constructed terminal instances so tests can
 * inspect `write()` calls (e.g. to verify replay seeding).
 *
 * The constructors are real `class` declarations rather than
 * `vi.fn().mockImplementation(...)` so that `vi.restoreAllMocks()` in
 * `afterEach` cannot wipe their behaviour between tests.
 */

import { vi } from 'vitest';

export interface MockTerminalInstance {
  write: ReturnType<typeof vi.fn>;
  loadAddon: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  cols: number;
  rows: number;
}

export const mockXtermInstances: MockTerminalInstance[] = [];

export function resetMockXterm(): void {
  mockXtermInstances.length = 0;
}

class MockTerminal implements MockTerminalInstance {
  write = vi.fn();
  loadAddon = vi.fn();
  open = vi.fn();
  onData = vi.fn(() => ({ dispose: vi.fn() }));
  focus = vi.fn();
  dispose = vi.fn();
  cols = 80;
  rows = 24;

  constructor() {
    mockXtermInstances.push(this);
  }
}

class MockFitAddon {
  fit = vi.fn();
  activate = vi.fn();
  dispose = vi.fn();
}

export function createXtermMock() {
  return { Terminal: MockTerminal };
}

export function createXtermFitAddonMock() {
  return { FitAddon: MockFitAddon };
}
