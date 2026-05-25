/**
 * Mock xterm.js modules for jsdom component tests.
 *
 * xterm requires a real DOM with canvas support; this mock provides
 * lightweight stand-ins that track write() calls so tests can verify
 * replay seeding and output routing without a real terminal.
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

export interface MockTerminalInstance {
  writtenData: string[];
  disposed: boolean;
}

let instances: MockTerminalInstance[] = [];

export function getXTermInstances(): MockTerminalInstance[] {
  return instances;
}

export function resetXTermInstances(): void {
  instances = [];
}

export function createXTermMock() {
  class Terminal {
    readonly _mock: MockTerminalInstance;
    cols = 80;
    rows = 24;

    constructor(_opts?: Record<string, unknown>) {
      this._mock = { writtenData: [], disposed: false };
      instances.push(this._mock);
    }
    loadAddon(_addon: unknown) {}
    open(_host: HTMLElement) {}
    write(data: string) { this._mock.writtenData.push(data); }
    onData(_cb: (data: string) => void) {
      return { dispose() {} };
    }
    focus() {}
    dispose() { this._mock.disposed = true; }
  }

  return { Terminal };
}

export function createFitAddonMock() {
  class FitAddon {
    fit() {}
  }
  return { FitAddon };
}
