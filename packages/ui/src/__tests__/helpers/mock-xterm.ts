/**
 * Mock xterm + xterm-addon-fit modules for jsdom component tests.
 *
 * The real `xterm` package tries to read CSS metrics and create a canvas
 * 2D context the first time `term.open(host)` runs, both of which throw in
 * jsdom. This mock provides a minimal Terminal whose API surface matches
 * what `TerminalSessionPane` exercises (`write`, `onData`, `loadAddon`,
 * `open`, `focus`, `dispose`, plus `cols`/`rows`) so tests can assert on
 * replay seeding and input/output routing without a real DOM renderer.
 *
 * Usage in tests:
 *   vi.mock('xterm', async () => {
 *     const { createXtermMock } = await import('./helpers/mock-xterm.js');
 *     return createXtermMock();
 *   });
 *   vi.mock('xterm-addon-fit', async () => {
 *     const { createXtermAddonFitMock } = await import('./helpers/mock-xterm.js');
 *     return createXtermAddonFitMock();
 *   });
 *
 * Then call `getMockTerminals()` to inspect constructed instances and
 * `resetMockTerminals()` between tests.
 */

import { vi } from 'vitest';

type DataListener = (data: string) => void;

export class MockXTermTerminal {
  cols = 80;
  rows = 24;
  open = vi.fn();
  loadAddon = vi.fn();
  focus = vi.fn();
  dispose = vi.fn();
  write = vi.fn();
  options: unknown;
  private listeners: DataListener[] = [];

  constructor(options?: unknown) {
    this.options = options;
    mockTerminalRegistry.push(this);
  }

  onData(cb: DataListener): { dispose: () => void } {
    this.listeners.push(cb);
    return {
      dispose: () => {
        const idx = this.listeners.indexOf(cb);
        if (idx >= 0) this.listeners.splice(idx, 1);
      },
    };
  }

  /** Test helper: simulate the user typing into the terminal. */
  emitData(data: string): void {
    for (const cb of [...this.listeners]) cb(data);
  }
}

export class MockFitAddon {
  fit = vi.fn();
}

const mockTerminalRegistry: MockXTermTerminal[] = [];

export function getMockTerminals(): readonly MockXTermTerminal[] {
  return mockTerminalRegistry;
}

export function getLastMockTerminal(): MockXTermTerminal | undefined {
  return mockTerminalRegistry[mockTerminalRegistry.length - 1];
}

export function resetMockTerminals(): void {
  mockTerminalRegistry.length = 0;
}

export function createXtermMock(): { Terminal: typeof MockXTermTerminal } {
  return { Terminal: MockXTermTerminal };
}

export function createXtermAddonFitMock(): { FitAddon: typeof MockFitAddon } {
  return { FitAddon: MockFitAddon };
}
