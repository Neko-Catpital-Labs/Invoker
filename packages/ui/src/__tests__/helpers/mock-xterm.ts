/**
 * Mock xterm + xterm-addon-fit modules for jsdom component tests.
 *
 * Real xterm constructs a DOM renderer that calls
 * HTMLCanvasElement.getContext, which jsdom does not implement. This mock
 * captures `term.write(...)` calls and `term.onData(...)` handlers so tests
 * can assert replay seeding and input routing without canvas.
 *
 * Usage in tests:
 *   vi.mock('xterm', async () => {
 *     const { createXtermMock } = await import('./helpers/mock-xterm.js');
 *     return createXtermMock();
 *   });
 *   vi.mock('xterm-addon-fit', async () => {
 *     const { createFitAddonMock } = await import('./helpers/mock-xterm.js');
 *     return createFitAddonMock();
 *   });
 *
 * Then call `resetXtermMockState()` in beforeEach.
 */

interface XtermMockState {
  writeCalls: string[];
  instances: MockTerminal[];
}

const state: XtermMockState = {
  writeCalls: [],
  instances: [],
};

class MockTerminal {
  cols = 80;
  rows = 24;
  private dataHandler: ((data: string) => void) | null = null;
  readonly writes: string[] = [];

  constructor(_options?: unknown) {
    state.instances.push(this);
  }

  loadAddon(_addon: unknown): void {}
  open(_host: HTMLElement): void {}
  focus(): void {}
  dispose(): void {}

  write(data: string): void {
    this.writes.push(data);
    state.writeCalls.push(data);
  }

  onData(handler: (data: string) => void): { dispose: () => void } {
    this.dataHandler = handler;
    return {
      dispose: () => {
        this.dataHandler = null;
      },
    };
  }

  emitData(data: string): void {
    this.dataHandler?.(data);
  }
}

class MockFitAddon {
  fit(): void {}
}

export function resetXtermMockState(): void {
  state.writeCalls.length = 0;
  state.instances.length = 0;
}

export function getXtermWriteCalls(): string[] {
  return state.writeCalls.slice();
}

export function getXtermInstances(): MockTerminal[] {
  return state.instances.slice();
}

export function createXtermMock(): { Terminal: typeof MockTerminal } {
  return { Terminal: MockTerminal };
}

export function createFitAddonMock(): { FitAddon: typeof MockFitAddon } {
  return { FitAddon: MockFitAddon };
}
