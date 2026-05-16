import type { BrowserWindow, BrowserWindowConstructorOptions, NativeImage } from 'electron';

interface AppLike {
  on(channel: 'second-instance', listener: () => void): void;
}

interface ShellLike {
  openExternal(url: string): Promise<void>;
}

interface NativeImageLike {
  createFromPath(path: string): NativeImage;
}

interface BrowserWindowConstructor<TWindow extends BrowserWindow> {
  new(options: BrowserWindowConstructorOptions): TWindow;
  getAllWindows(): TWindow[];
}

interface WindowLifecycleLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface CreateMainWindowOptions<TWindow extends BrowserWindow> {
  BrowserWindow: BrowserWindowConstructor<TWindow>;
  nativeImage: NativeImageLike;
  shell: ShellLike;
  spawn(command: string, args: string[], options: { detached: boolean; stdio: 'ignore' }): { unref(): void };
  dirname: string;
  platform: NodeJS.Platform;
  devServerUrl?: string;
  existsSync(path: string): boolean;
  joinPath(...parts: string[]): string;
  logger: WindowLifecycleLogger;
  browserCommand?: string;
  enableTestCompositor: boolean;
  nodeEnv?: string;
  fallbackHtml: string;
  createInvokerWindow(options: {
    BrowserWindow: BrowserWindowConstructor<TWindow>;
    nativeImage: NativeImageLike;
    dirname: string;
    platform: NodeJS.Platform;
    devServerUrl?: string;
    existsSync(path: string): boolean;
    joinPath(...parts: string[]): string;
    logger: WindowLifecycleLogger;
    recordStartupMark(name: string, meta?: Record<string, unknown>): void;
    onWindowCreated(window: TWindow): void;
    fallbackHtml: string;
  }): TWindow;
  recordStartupMark(name: string, meta?: Record<string, unknown>): void;
  setMainWindow(window: TWindow | null): void;
  setUiInteractive(value: boolean): void;
  startDeferredStartupWork(): void;
}

export function createMainWindow<TWindow extends BrowserWindow>(
  options: CreateMainWindowOptions<TWindow>,
): TWindow {
  const mainWindow = options.createInvokerWindow({
    BrowserWindow: options.BrowserWindow,
    nativeImage: options.nativeImage,
    dirname: options.dirname,
    platform: options.platform,
    devServerUrl: options.devServerUrl,
    existsSync: options.existsSync,
    joinPath: options.joinPath,
    logger: options.logger,
    recordStartupMark: options.recordStartupMark,
    onWindowCreated: options.setMainWindow,
    fallbackHtml: options.fallbackHtml,
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    options.logger.error(
      `main window render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`,
      { module: 'window' },
    );
  });

  const shouldShowWindow = options.nodeEnv !== 'test' || options.enableTestCompositor;
  if (shouldShowWindow) {
    let showTriggered = false;
    const showWindow = (): void => {
      if (mainWindow.isDestroyed() || showTriggered) return;
      showTriggered = true;
      options.logger.info('main window show()', { module: 'window' });
      options.recordStartupMark('window.show');
      mainWindow.show();
      mainWindow.focus();
      options.setUiInteractive(true);
      options.recordStartupMark('ui.interactive');
      options.startDeferredStartupWork();
    };

    mainWindow.once('ready-to-show', showWindow);
    setTimeout(showWindow, 1500).unref?.();
  } else {
    options.setUiInteractive(true);
    options.recordStartupMark('ui.interactive');
    options.startDeferredStartupWork();
  }

  mainWindow.on('closed', () => {
    options.logger.info('main window closed', { module: 'window' });
    options.setMainWindow(null);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      openExternalUrl(url, options);
    }
    return { action: 'deny' as const };
  });

  return mainWindow;
}

export function registerSecondInstanceFocus<TWindow extends BrowserWindow>(
  app: AppLike,
  getMainWindow: () => TWindow | null,
): void {
  app.on('second-instance', () => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function openExternalUrl<TWindow extends BrowserWindow>(
  url: string,
  options: CreateMainWindowOptions<TWindow>,
): void {
  const browserCmd = options.browserCommand;
  if (browserCmd) {
    options.spawn(browserCmd, [url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }

  const chromeCmd: [string, string[]] = options.platform === 'darwin'
    ? ['open', ['-a', 'Google Chrome', url]]
    : options.platform === 'win32'
      ? ['cmd', ['/c', 'start', 'chrome', url]]
      : ['google-chrome', [url]];
  try {
    options.spawn(chromeCmd[0], chromeCmd[1], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    void options.shell.openExternal(url);
  }
}
