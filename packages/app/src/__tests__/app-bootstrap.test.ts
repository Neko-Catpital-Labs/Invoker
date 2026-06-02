import { describe, expect, it, vi } from 'vitest';
import {
  configureEarlyElectronApp,
  registerGuiLifecycleHandlers,
  runElectronReadyBootstrap,
  startGuiModeBootstrap,
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
