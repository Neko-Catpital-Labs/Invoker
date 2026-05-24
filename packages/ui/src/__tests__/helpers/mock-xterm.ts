/**
 * Mock xterm + xterm-addon-fit modules for jsdom component tests.
 *
 * xterm's DomRenderer touches HTMLCanvasElement.getContext, which jsdom does
 * not implement. The real terminal still constructs but its internal rendering
 * fails. Replacing the module with a lightweight mock lets tests assert on
 * `term.write` (snapshot replay, live output) without driving real DOM
 * rendering, and exposes constructed instances via the shared `xtermState`
 * registry so tests can spy on per-pane behavior.
 *
 * Usage in tests:
 *   vi.mock('xterm', async () => {
 *     const { createXtermModuleMock } = await import('./helpers/mock-xterm.js');
 *     return createXtermModuleMock();
 *   });
 *   vi.mock('xterm-addon-fit', async () => {
 *     const { createFitAddonModuleMock } = await import('./helpers/mock-xterm.js');
 *     return createFitAddonModuleMock();
 *   });
 */

import { vi, type Mock } from 'vitest';

export interface MockXtermInstance {
  write: Mock;
  dispose: Mock;
  focus: Mock;
  loadAddon: Mock;
  open: Mock;
  onData: Mock;
  cols: number;
  rows: number;
  /** Trigger the most-recently registered onData listener. */
  emitInput: (data: string) => void;
}

export interface MockFitAddonInstance {
  fit: Mock;
  dispose: Mock;
}

export const xtermState = {
  instances: [] as MockXtermInstance[],
  fitInstances: [] as MockFitAddonInstance[],
  reset(): void {
    this.instances.length = 0;
    this.fitInstances.length = 0;
  },
};

function createXtermInstance(): MockXtermInstance {
  let inputListener: ((data: string) => void) | undefined;
  const inst: MockXtermInstance = {
    write: vi.fn(),
    dispose: vi.fn(),
    focus: vi.fn(),
    loadAddon: vi.fn(),
    open: vi.fn(),
    onData: vi.fn((listener: (data: string) => void) => {
      inputListener = listener;
      return { dispose: vi.fn(() => { inputListener = undefined; }) };
    }),
    cols: 80,
    rows: 24,
    emitInput(data: string): void {
      inputListener?.(data);
    },
  };
  xtermState.instances.push(inst);
  return inst;
}

function createFitAddonInstance(): MockFitAddonInstance {
  const inst: MockFitAddonInstance = {
    fit: vi.fn(),
    dispose: vi.fn(),
  };
  xtermState.fitInstances.push(inst);
  return inst;
}

export function createXtermModuleMock(): { Terminal: new () => MockXtermInstance } {
  class MockTerminal {
    constructor() {
      return createXtermInstance();
    }
  }
  return {
    Terminal: MockTerminal as unknown as new () => MockXtermInstance,
  };
}

export function createFitAddonModuleMock(): { FitAddon: new () => MockFitAddonInstance } {
  class MockFitAddon {
    constructor() {
      return createFitAddonInstance();
    }
  }
  return {
    FitAddon: MockFitAddon as unknown as new () => MockFitAddonInstance,
  };
}
