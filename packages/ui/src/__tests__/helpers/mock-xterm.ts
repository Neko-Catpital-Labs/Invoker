/**
 * Mock `xterm` and `xterm-addon-fit` modules for jsdom component tests.
 *
 * The real xterm Terminal tries to render via canvas APIs that jsdom does not
 * implement, so the production `TerminalSessionPane` wraps construction in a
 * try/catch and falls back to no-op behavior. That makes it impossible to
 * assert that `term.write(...)` was called with the replay snapshot. This
 * helper installs lightweight stubs that record every constructed Terminal so
 * tests can spy on `write`, `open`, etc.
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
 * Then call `getMockTerminals()` to retrieve all constructed instances since
 * the last `resetMockTerminals()`.
 *
 * The constructed-terminal registry is hung off `globalThis` so that the
 * dynamic-import copy of this module loaded inside the `vi.mock` factory and
 * the static-import copy used by the test file share the same backing store
 * (each import path can otherwise resolve to a distinct module instance under
 * vitest, leaving the test-side array always empty).
 *
 * The Terminal class is intentionally a plain ES class (not `vi.fn()`) so that
 * `vi.restoreAllMocks()` between tests does not wipe out the implementation
 * and leave subsequent tests with a no-op constructor.
 */

export interface MockTerminal {
  options: unknown;
  opened: HTMLElement[];
  writeCalls: string[];
  loadAddonCalls: unknown[];
  focusCallCount: number;
  disposeCallCount: number;
  onDataCallbacks: Array<(data: string) => void>;
  cols: number;
  rows: number;
  write: (data: string) => void;
  open: (host: HTMLElement) => void;
  loadAddon: (addon: unknown) => void;
  focus: () => void;
  dispose: () => void;
  onData: (cb: (data: string) => void) => { dispose: () => void };
  /** Concatenated string of every recorded `write` call. */
  writtenText: () => string;
}

const REGISTRY_KEY = '__INVOKER_TEST_MOCK_TERMINALS__';

function registry(): MockTerminal[] {
  const g = globalThis as Record<string, unknown>;
  if (!Array.isArray(g[REGISTRY_KEY])) {
    g[REGISTRY_KEY] = [] as MockTerminal[];
  }
  return g[REGISTRY_KEY] as MockTerminal[];
}

export function getMockTerminals(): MockTerminal[] {
  return registry().slice();
}

export function resetMockTerminals(): void {
  registry().length = 0;
}

class MockTerminalImpl implements MockTerminal {
  options: unknown;
  opened: HTMLElement[] = [];
  writeCalls: string[] = [];
  loadAddonCalls: unknown[] = [];
  focusCallCount = 0;
  disposeCallCount = 0;
  onDataCallbacks: Array<(data: string) => void> = [];
  cols = 80;
  rows = 24;

  constructor(options: unknown) {
    this.options = options;
    registry().push(this);
  }

  write(data: string): void {
    this.writeCalls.push(data);
  }

  open(host: HTMLElement): void {
    this.opened.push(host);
  }

  loadAddon(addon: unknown): void {
    this.loadAddonCalls.push(addon);
  }

  focus(): void {
    this.focusCallCount += 1;
  }

  dispose(): void {
    this.disposeCallCount += 1;
  }

  onData(cb: (data: string) => void): { dispose: () => void } {
    this.onDataCallbacks.push(cb);
    return {
      dispose: () => {
        const idx = this.onDataCallbacks.indexOf(cb);
        if (idx >= 0) this.onDataCallbacks.splice(idx, 1);
      },
    };
  }

  writtenText(): string {
    return this.writeCalls.join('');
  }
}

class MockFitAddon {
  fit(): void {}
}

export function createXtermMock() {
  return { Terminal: MockTerminalImpl };
}

export function createXtermAddonFitMock() {
  return { FitAddon: MockFitAddon };
}
