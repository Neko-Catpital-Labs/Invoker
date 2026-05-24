/**
 * Mock the `xterm` and `xterm-addon-fit` modules for jsdom component tests.
 *
 * Real xterm needs a Canvas 2D context which jsdom does not implement, so
 * tests that mount the terminal drawer mock the module out entirely. The
 * mock exposes the constructed terminal instances via `getMockTerminals()`
 * so tests can assert on `write()` calls and other interactions.
 *
 * Usage in tests:
 *   vi.mock('xterm', async () => {
 *     const mod = await import('./helpers/mock-xterm.js');
 *     return mod.createXTermMock();
 *   });
 *   vi.mock('xterm-addon-fit', async () => {
 *     const mod = await import('./helpers/mock-xterm.js');
 *     return mod.createFitAddonMock();
 *   });
 */

import { vi } from 'vitest';

export interface MockTerminal {
  options: unknown;
  cols: number;
  rows: number;
  write: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
  loadAddon: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  emitData: (data: string) => void;
  __dataListeners: Array<(data: string) => void>;
}

const terminals: MockTerminal[] = [];

class TerminalMock implements MockTerminal {
  cols = 80;
  rows = 24;
  write = vi.fn();
  open = vi.fn();
  loadAddon = vi.fn();
  focus = vi.fn();
  dispose = vi.fn();
  onData = vi.fn((listener: (data: string) => void) => {
    this.__dataListeners.push(listener);
    return {
      dispose: () => {
        this.__dataListeners = this.__dataListeners.filter((l) => l !== listener);
      },
    };
  });
  __dataListeners: Array<(data: string) => void> = [];

  constructor(public options: unknown) {
    terminals.push(this);
  }

  emitData(data: string): void {
    for (const listener of this.__dataListeners) listener(data);
  }
}

class FitAddonMock {
  fit = vi.fn();
}

export function createXTermMock() {
  return { Terminal: TerminalMock };
}

export function createFitAddonMock() {
  return { FitAddon: FitAddonMock };
}

export function getMockTerminals(): MockTerminal[] {
  return terminals;
}

export function resetMockTerminals(): void {
  terminals.length = 0;
}
