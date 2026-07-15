import { BrowserWindow, nativeImage, shell, type App } from 'electron';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { Logger } from '@invoker/contracts';
import type { InvokerConfig } from '../config.js';

export interface MainWindowLifecycleDeps {
  appRootDir: string;
  invokerConfig: InvokerConfig;
  logger: Logger;
  hideE2eWindow: boolean;
  enableTestCompositor: boolean;
  recordStartupMark: (phase: string, extra?: Record<string, unknown>) => void;
  setUiInteractive: (uiInteractive: boolean) => void;
  startDeferredStartupWork: () => void;
  setMainWindow: (window: BrowserWindow | null) => void;
}

export interface MainWindowSecondInstanceDeps {
  app: Pick<App, 'on'>;
  getMainWindow: () => BrowserWindow | null;
}

export interface MainWindowActivateDeps {
  app: Pick<App, 'on'>;
  createWindow: () => void;
  browserWindow?: Pick<typeof BrowserWindow, 'getAllWindows'>;
}

export function registerMainWindowSecondInstanceHandler(deps: MainWindowSecondInstanceDeps): void {
  deps.app.on('second-instance', () => {
    const mainWindow = deps.getMainWindow();
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

export function registerMainWindowActivateHandler(deps: MainWindowActivateDeps): void {
  const browserWindow = deps.browserWindow ?? BrowserWindow;
  deps.app.on('activate', () => {
    if (browserWindow.getAllWindows().length === 0) {
      deps.createWindow();
    }
  });
}

const FALLBACK_WINDOW_HTML = 'data:text/html,<html><body style="background:#1a1a2e;color:#eee;font-family:system-ui;padding:2rem"><h1>Invoker</h1><p>The UI failed to load. Restart Invoker. If this keeps happening, reinstall Invoker or rebuild the UI from a source checkout.</p></body></html>';

export function createMainWindow(deps: MainWindowLifecycleDeps): BrowserWindow {
  deps.recordStartupMark('createWindow.begin');
  const iconPath = path.join(deps.appRootDir, 'assets', 'icons', 'png', '256x256.png');
  const icon = nativeImage.createFromPath(iconPath);
  const keepE2eWindowHidden = deps.hideE2eWindow && !deps.enableTestCompositor;
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    ...(deps.hideE2eWindow
      ? { ...(keepE2eWindowHidden ? { x: -32000, y: -32000 } : {}), skipTaskbar: true }
      : {}),
    // Show explicitly after load/timeout rather than relying on Electron's
    // implicit initial map behavior, which has regressed on some Linux/X11
    // sessions and leaves the BrowserWindow unmapped. Compositor-enabled E2E
    // tests must map the window so Chromium does not throttle requestAnimationFrame.
    show: false,
    webPreferences: {
      preload: path.join(deps.appRootDir, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    icon: !icon.isEmpty() && process.platform !== 'darwin' ? icon : undefined,
    title: 'Invoker',
  });
  deps.setMainWindow(mainWindow);

  // BrowserWindow icons matter on Windows/Linux. macOS uses the bundle icon.
  if (process.platform !== 'darwin') {
    if (!icon.isEmpty()) mainWindow.setIcon(icon);
  }

  let fallbackShown = false;
  const showFallbackWindow = (reason: string): void => {
    if (mainWindow.isDestroyed() || fallbackShown) return;
    fallbackShown = true;
    deps.logger.error(`main window fallback shown: ${reason}`, { module: 'window' });
    mainWindow.loadURL(FALLBACK_WINDOW_HTML).catch((err) => {
      deps.logger.error(`main window fallback failed: ${err instanceof Error ? err.message : String(err)}`, { module: 'window' });
    });
  };

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl).catch((err) => {
      showFallbackWindow(`dev URL load failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  } else {
    const packagedUiPath = path.join(deps.appRootDir, 'ui', 'index.html');
    const repoUiPath = path.join(deps.appRootDir, '..', '..', 'ui', 'dist', 'index.html');
    const uiDistPath = existsSync(packagedUiPath) ? packagedUiPath : repoUiPath;
    mainWindow.loadFile(uiDistPath).catch((err) => {
      showFallbackWindow(`UI file load failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  mainWindow.webContents.on('did-finish-load', () => {
    deps.logger.info('main window did-finish-load', { module: 'window' });
    deps.recordStartupMark('window.did-finish-load');
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    deps.logger.error(
      `main window did-fail-load: code=${errorCode} desc=${errorDescription} url=${validatedURL}`,
      { module: 'window' },
    );
    showFallbackWindow(`did-fail-load code=${errorCode} desc=${errorDescription}`);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    deps.logger.error(
      `main window render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`,
      { module: 'window' },
    );
    showFallbackWindow(`render-process-gone reason=${details.reason} exitCode=${details.exitCode}`);
  });

  const shouldShowWindow = process.env.NODE_ENV !== 'test' || deps.enableTestCompositor;
  if (shouldShowWindow) {
    let showTriggered = false;
    const showWindow = (): void => {
      if (mainWindow.isDestroyed() || showTriggered) return;
      showTriggered = true;
      deps.logger.info(keepE2eWindowHidden ? 'main window ready while hidden' : 'main window show()', { module: 'window' });
      deps.recordStartupMark(keepE2eWindowHidden ? 'window.hidden-ready' : 'window.show');
      if (!keepE2eWindowHidden) {
        mainWindow.show();
        mainWindow.focus();
      }
      deps.setUiInteractive(true);
      deps.recordStartupMark('ui.interactive');
      deps.startDeferredStartupWork();
    };

    mainWindow.once('ready-to-show', showWindow);
    setTimeout(showWindow, 1500).unref?.();
  } else {
    deps.setUiInteractive(true);
    deps.recordStartupMark('ui.interactive');
    deps.startDeferredStartupWork();
  }

  mainWindow.on('closed', () => {
    deps.logger.info('main window closed', { module: 'window' });
    deps.setMainWindow(null);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      const browserCmd = deps.invokerConfig.browser;
      if (browserCmd) {
        spawn(browserCmd, [url], { detached: true, stdio: 'ignore' }).unref();
      } else {
        const chromeCmd: [string, string[]] = process.platform === 'darwin'
          ? ['open', ['-a', 'Google Chrome', url]]
          : process.platform === 'win32'
            ? ['cmd', ['/c', 'start', 'chrome', url]]
            : ['google-chrome', [url]];
        try {
          spawn(chromeCmd[0], chromeCmd[1], { detached: true, stdio: 'ignore' }).unref();
        } catch {
          shell.openExternal(url);
        }
      }
    }
    return { action: 'deny' as const };
  });

  return mainWindow;
}
