import { describe, expect, it, vi } from 'vitest';
import {
  configureEarlyElectronApp,
  registerGuiLifecycleHandlers,
  runElectronReadyBootstrap,
  startGuiModeBootstrap,
  startMainProcessBootstrap,
} from '../bootstrap/app-bootstrap.js';

function createCommandLineRecorder() {
  const switches: string[] = [];
  return {
    switches,
    commandLine: {
      appendSwitch: (value: string) => {
        switches.push(value);
      },
    },
  };
}

describe('app-bootstrap', () => {
  it('applies Linux startup switches before later bootstrap work', () => {
    const recorder = createCommandLineRecorder();
    const disableHardwareAcceleration = vi.fn();
    const app = {
      disableHardwareAcceleration,
      commandLine: recorder.commandLine,
      name: '',
    };

    configureEarlyElectronApp({
      app,
      platform: 'linux',
      enableTestCompositor: false,
      isHeadless: false,
    });

    expect(disableHardwareAcceleration).toHaveBeenCalledTimes(1);
    expect(app.name).toBe('invoker');
    expect(recorder.switches).toEqual([
      'no-sandbox',
      'no-zygote',
      'disable-dev-shm-usage',
      'disable-gpu',
      'disable-gpu-compositing',
      'disable-gpu-sandbox',
      'disable-software-rasterizer',
      'class',
    ]);
  });

  it('keeps macOS headless mode out of the Dock', () => {
    const recorder = createCommandLineRecorder();
    const setActivationPolicy = vi.fn();
    const hideDock = vi.fn();
    const app = {
      disableHardwareAcceleration: vi.fn(),
      commandLine: recorder.commandLine,
      name: '',
      setActivationPolicy,
      dock: {
        hide: hideDock,
      },
    };

    configureEarlyElectronApp({
      app,
      platform: 'darwin',
      enableTestCompositor: false,
      isHeadless: true,
    });

    expect(setActivationPolicy).toHaveBeenCalledWith('accessory');
    expect(hideDock).toHaveBeenCalledTimes(1);
  });

  it('does not hide the Dock for macOS GUI mode', () => {
    const recorder = createCommandLineRecorder();
    const setActivationPolicy = vi.fn();
    const hideDock = vi.fn();
    const app = {
      disableHardwareAcceleration: vi.fn(),
      commandLine: recorder.commandLine,
      name: '',
      setActivationPolicy,
      dock: {
        hide: hideDock,
      },
    };

    configureEarlyElectronApp({
      app,
      platform: 'darwin',
      enableTestCompositor: false,
      isHeadless: false,
    });

    expect(setActivationPolicy).not.toHaveBeenCalled();
    expect(hideDock).not.toHaveBeenCalled();
  });

  it('runs ready bootstrap only after Electron readiness resolves', async () => {
    const order: string[] = [];
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const run = vi.fn(async () => {
      order.push('run');
    });

    runElectronReadyBootstrap({
      app: {
        whenReady: () => {
          order.push('whenReady');
          return ready;
        },
      },
      run,
      onError: vi.fn(),
    });

    expect(order).toEqual(['whenReady']);
    resolveReady();
    await ready;
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['whenReady', 'run']);
  });

  it('preserves GUI single-instance ordering outside tests', () => {
    const order: string[] = [];
    startGuiModeBootstrap({
      app: {
        requestSingleInstanceLock: () => {
          order.push('lock');
          return true;
        },
        quit: () => {
          order.push('quit');
        },
      },
      isTest: false,
      setupGuiMode: () => {
        order.push('setup');
      },
    });

    expect(order).toEqual(['lock', 'setup']);
  });

  it('skips the single-instance lock in tests', () => {
    const requestSingleInstanceLock = vi.fn(() => true);
    const setupGuiMode = vi.fn();

    startGuiModeBootstrap({
      app: {
        requestSingleInstanceLock,
        quit: vi.fn(),
      },
      isTest: true,
      setupGuiMode,
    });

    expect(requestSingleInstanceLock).not.toHaveBeenCalled();
    expect(setupGuiMode).toHaveBeenCalledTimes(1);
  });

  it('delegates the composition root to headless or GUI startup without reordering callbacks', () => {
    const order: string[] = [];

    startMainProcessBootstrap({
      isHeadless: true,
      startHeadlessMode: () => {
        order.push('headless');
      },
      startGuiMode: () => {
        order.push('gui');
      },
    });

    startMainProcessBootstrap({
      isHeadless: false,
      startHeadlessMode: () => {
        order.push('headless');
      },
      startGuiMode: () => {
        order.push('gui');
      },
    });

    expect(order).toEqual(['headless', 'gui']);
  });

  it('registers lifecycle handlers without changing event names', () => {
    const handlers = new Map<string, unknown>();
    registerGuiLifecycleHandlers(
      {
        on: (eventName: string, handler: unknown) => {
          handlers.set(eventName, handler);
          return undefined as never;
        },
      },
      {
        onWindowAllClosed: vi.fn(),
        onBeforeQuit: vi.fn(),
      },
    );

    expect([...handlers.keys()]).toEqual(['window-all-closed', 'before-quit']);
  });
});
