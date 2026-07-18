import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  createMainWindow,
  registerMainWindowActivateHandler,
  registerMainWindowSecondInstanceHandler,
} from '../window/window-lifecycle.js';

const electronMock = vi.hoisted(() => {
  const webContentsHandlers = new Map<string, (...args: unknown[]) => void>();
  const fakeWindow = {
    webContents: {
      on: vi.fn((eventName: string, handler: (...args: unknown[]) => void) => {
        webContentsHandlers.set(eventName, handler);
        return undefined;
      }),
      setWindowOpenHandler: vi.fn(),
    },
    loadURL: vi.fn(() => Promise.resolve()),
    loadFile: vi.fn(() => Promise.resolve()),
    isDestroyed: vi.fn(() => false),
    setIcon: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    showInactive: vi.fn(),
  };
  const BrowserWindow = Object.assign(
    vi.fn(() => fakeWindow),
    { getAllWindows: vi.fn((): unknown[] => []) },
  );
  return { BrowserWindow, fakeWindow, webContentsHandlers };
});

vi.mock('electron', () => ({
  BrowserWindow: electronMock.BrowserWindow,
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true }),
  },
  shell: {
    openExternal: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  electronMock.webContentsHandlers.clear();
  electronMock.fakeWindow.isDestroyed.mockReturnValue(false);
  electronMock.fakeWindow.loadURL.mockResolvedValue(undefined);
  electronMock.fakeWindow.loadFile.mockResolvedValue(undefined);
});

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

  it('shows a diagnostic page when the renderer fails to load after the window exists', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
    createMainWindow({
      appRootDir: '/tmp/missing-app',
      invokerConfig: {},
      logger,
      hideE2eWindow: false,
      enableTestCompositor: false,
      recordStartupMark: vi.fn(),
      setUiInteractive: vi.fn(),
      startDeferredStartupWork: vi.fn(),
      setMainWindow: vi.fn(),
    });

    electronMock.webContentsHandlers.get('did-fail-load')?.({}, -6, 'ERR_FILE_NOT_FOUND', 'file:///missing/index.html');

    expect(electronMock.fakeWindow.loadURL).toHaveBeenCalledWith(expect.stringContaining('The UI failed to load'));
    expect(logger.error).toHaveBeenCalledWith(
      'main window did-fail-load: code=-6 desc=ERR_FILE_NOT_FOUND url=file:///missing/index.html',
      { module: 'window' },
    );
  });

  it('shows a diagnostic page when the renderer process dies instead of leaving a white window', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
    createMainWindow({
      appRootDir: '/tmp/app',
      invokerConfig: {},
      logger,
      hideE2eWindow: false,
      enableTestCompositor: false,
      recordStartupMark: vi.fn(),
      setUiInteractive: vi.fn(),
      startDeferredStartupWork: vi.fn(),
      setMainWindow: vi.fn(),
    });

    electronMock.webContentsHandlers.get('render-process-gone')?.({}, { reason: 'crashed', exitCode: 9 });

    expect(electronMock.fakeWindow.loadURL).toHaveBeenCalledWith(expect.stringContaining('The UI failed to load'));
  });

  it('maps and focuses e2e compositor windows', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
    const recordStartupMark = vi.fn();
    const setUiInteractive = vi.fn();
    const startDeferredStartupWork = vi.fn();

    createMainWindow({
      appRootDir: '/tmp/app',
      invokerConfig: {},
      logger,
      hideE2eWindow: true,
      enableTestCompositor: true,
      recordStartupMark,
      setUiInteractive,
      startDeferredStartupWork,
      setMainWindow: vi.fn(),
    });

    const options = electronMock.BrowserWindow.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.show).toBe(false);
    expect(options.skipTaskbar).toBe(true);
    expect(options.x).toBeUndefined();
    expect(options.y).toBeUndefined();

    const readyHandler = electronMock.fakeWindow.once.mock.calls.find(([eventName]) => eventName === 'ready-to-show')?.[1];
    expect(readyHandler).toBeDefined();
    readyHandler?.();

    expect(electronMock.fakeWindow.show).toHaveBeenCalledTimes(1);
    expect(electronMock.fakeWindow.showInactive).not.toHaveBeenCalled();
    expect(electronMock.fakeWindow.focus).toHaveBeenCalledTimes(1);
    expect(setUiInteractive).toHaveBeenCalledWith(true);
    expect(startDeferredStartupWork).toHaveBeenCalledTimes(1);
    expect(recordStartupMark).toHaveBeenCalledWith('window.show');
  });

  it('keeps non-compositor e2e windows hidden', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
    const recordStartupMark = vi.fn();
    const setUiInteractive = vi.fn();
    const startDeferredStartupWork = vi.fn();

    createMainWindow({
      appRootDir: '/tmp/app',
      invokerConfig: {},
      logger,
      hideE2eWindow: true,
      enableTestCompositor: false,
      recordStartupMark,
      setUiInteractive,
      startDeferredStartupWork,
      setMainWindow: vi.fn(),
    });

    const options = electronMock.BrowserWindow.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.show).toBe(false);
    expect(options.skipTaskbar).toBe(true);
    expect(options.x).toBe(-32000);
    expect(options.y).toBe(-32000);
    expect(electronMock.fakeWindow.show).not.toHaveBeenCalled();
    expect(electronMock.fakeWindow.showInactive).not.toHaveBeenCalled();
    expect(electronMock.fakeWindow.focus).not.toHaveBeenCalled();
    expect(setUiInteractive).toHaveBeenCalledWith(true);
    expect(startDeferredStartupWork).toHaveBeenCalledTimes(1);
    expect(recordStartupMark).toHaveBeenCalledWith('ui.interactive');
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
