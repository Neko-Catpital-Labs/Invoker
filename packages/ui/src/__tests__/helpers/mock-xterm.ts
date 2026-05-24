/**
 * Mock xterm and xterm-addon-fit modules for jsdom component tests.
 *
 * Real xterm reaches into HTMLCanvasElement.getContext() during open(), which
 * jsdom does not implement. The tests don't care about rendered cells — they
 * only need to observe which bytes the renderer hands to `term.write()` so
 * replay-seeding and live-output behaviour can be asserted.
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
 *   beforeEach(() => resetXtermMockState());
 *   const term = getLatestXtermInstance();
 *   expect(term?.writes).toEqual(['snapshot bytes', 'live bytes']);
 */

export interface MockTerminalInstance {
  writes: string[];
  opened: boolean;
  disposed: boolean;
  inputListeners: Array<(data: string) => void>;
  cols: number;
  rows: number;
  focus: () => void;
}

const state: { instances: MockTerminalInstance[] } = { instances: [] };

export function resetXtermMockState(): void {
  state.instances = [];
}

export function getXtermInstances(): readonly MockTerminalInstance[] {
  return state.instances;
}

export function getLatestXtermInstance(): MockTerminalInstance | undefined {
  return state.instances[state.instances.length - 1];
}

export function createXtermMock(): { Terminal: new (opts?: unknown) => MockTerminalInstance } {
  class MockTerminal implements MockTerminalInstance {
    writes: string[] = [];
    opened = false;
    disposed = false;
    inputListeners: Array<(data: string) => void> = [];
    cols = 80;
    rows = 24;

    constructor(_opts?: unknown) {
      state.instances.push(this);
    }

    open(_host: HTMLElement): void {
      this.opened = true;
    }

    loadAddon(_addon: unknown): void {
      /* no-op */
    }

    write(data: string): void {
      this.writes.push(data);
    }

    onData(listener: (data: string) => void): { dispose: () => void } {
      this.inputListeners.push(listener);
      return {
        dispose: () => {
          this.inputListeners = this.inputListeners.filter((fn) => fn !== listener);
        },
      };
    }

    focus(): void {
      /* no-op */
    }

    dispose(): void {
      this.disposed = true;
    }
  }
  return { Terminal: MockTerminal };
}

export function createFitAddonMock(): { FitAddon: new () => { fit: () => void; dispose: () => void } } {
  class MockFitAddon {
    fit(): void {
      /* no-op */
    }
    dispose(): void {
      /* no-op */
    }
  }
  return { FitAddon: MockFitAddon };
}
