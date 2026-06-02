import { describe, expect, it, vi } from 'vitest';
import {
  registerMainWindowActivateHandler,
  registerMainWindowSecondInstanceHandler,
} from '../window/window-lifecycle.js';

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [],
  },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true }),
  },
  shell: {
    openExternal: vi.fn(),
  },
}));

describe('window-lifecycle', () => {
  it('focuses the existing window on second-instance without changing the event name', () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const window = {
      isMinimized: vi.fn(() => true),
      restore: vi.fn(),
      focus: vi.fn(),
    };

    registerMainWindowSecondInstanceHandler({
      app: {
        on: (eventName: string, handler: (...args: unknown[]) => void) => {
          handlers.set(eventName, handler);
          return undefined as never;
        },
      },
      getMainWindow: () => window as any,
    });

    handlers.get('second-instance')?.();

    expect([...handlers.keys()]).toEqual(['second-instance']);
    expect(window.restore).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
  });

  it('recreates the main window on activate only when no BrowserWindow exists', () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const createWindow = vi.fn();
    const browserWindow = {
      getAllWindows: vi.fn(() => []),
    };

    registerMainWindowActivateHandler({
      app: {
        on: (eventName: string, handler: (...args: unknown[]) => void) => {
          handlers.set(eventName, handler);
          return undefined as never;
        },
      },
      createWindow,
      browserWindow,
    });

    handlers.get('activate')?.();
    expect(createWindow).toHaveBeenCalledTimes(1);

    browserWindow.getAllWindows.mockReturnValueOnce([{}]);
    handlers.get('activate')?.();
    expect(createWindow).toHaveBeenCalledTimes(1);
  });
});
