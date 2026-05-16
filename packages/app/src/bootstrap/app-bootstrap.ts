import type { BrowserWindowConstructorOptions } from 'electron';

interface ElectronAppLike {
  whenReady(): Promise<void>;
  on(channel: 'activate', listener: () => void): void;
  on(channel: 'window-all-closed', listener: () => void): void;
  on(channel: 'before-quit', listener: (event: { preventDefault(): void }) => void | Promise<void>): void;
}

interface BrowserWindowLike {
  isDestroyed(): boolean;
  loadFile(path: string): Promise<void>;
  loadURL(url: string): Promise<void>;
  setIcon(icon: unknown): void;
  webContents: {
    on(channel: 'did-finish-load', listener: () => void): void;
    on(
      channel: 'did-fail-load',
      listener: (
        event: unknown,
        errorCode: number,
        errorDescription: string,
        validatedURL: string,
      ) => void,
    ): void;
  };
}

interface BrowserWindowConstructor<TWindow extends BrowserWindowLike> {
  new(options: BrowserWindowConstructorOptions): TWindow;
  getAllWindows(): TWindow[];
}

interface NativeImageLike {
  createFromPath(path: string): {
    isEmpty(): boolean;
  };
}

interface BootstrapLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface CreateInvokerWindowOptions<TWindow extends BrowserWindowLike> {
  BrowserWindow: BrowserWindowConstructor<TWindow>;
  nativeImage: NativeImageLike;
  dirname: string;
  platform: NodeJS.Platform;
  devServerUrl?: string;
  existsSync(path: string): boolean;
  joinPath(...parts: string[]): string;
  logger: BootstrapLogger;
  recordStartupMark(name: string, meta?: Record<string, unknown>): void;
  onWindowCreated(window: TWindow): void;
  fallbackHtml: string;
}

export function createInvokerWindow<TWindow extends BrowserWindowLike>(
  options: CreateInvokerWindowOptions<TWindow>,
): TWindow {
  options.recordStartupMark('createWindow.begin');
  const iconPath = options.joinPath(options.dirname, 'assets', 'icons', 'png', '256x256.png');
  const icon = options.nativeImage.createFromPath(iconPath);
  const mainWindow = new options.BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      preload: options.joinPath(options.dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    icon: !icon.isEmpty() && options.platform !== 'darwin' ? icon : undefined,
    title: 'Invoker',
  });

  options.onWindowCreated(mainWindow);

  if (options.platform !== 'darwin' && !icon.isEmpty()) {
    mainWindow.setIcon(icon);
  }

  if (options.devServerUrl) {
    mainWindow.loadURL(options.devServerUrl);
  } else {
    const packagedUiPath = options.joinPath(options.dirname, 'ui', 'index.html');
    const repoUiPath = options.joinPath(options.dirname, '..', '..', 'ui', 'dist', 'index.html');
    const uiDistPath = options.existsSync(packagedUiPath) ? packagedUiPath : repoUiPath;
    mainWindow.loadFile(uiDistPath).catch(() => {
      mainWindow.loadURL(options.fallbackHtml);
    });
  }

  mainWindow.webContents.on('did-finish-load', () => {
    options.logger.info('main window did-finish-load', { module: 'window' });
    options.recordStartupMark('window.did-finish-load');
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    options.logger.error(
      `main window did-fail-load: code=${errorCode} desc=${errorDescription} url=${validatedURL}`,
      { module: 'window' },
    );
  });

  return mainWindow;
}

export interface GuiBootstrapLifecycleOptions {
  app: ElectronAppLike;
  BrowserWindow: { getAllWindows(): unknown[] };
  onReady(): Promise<void>;
  onReadyError(error: unknown): void;
  createWindow(): void;
  onWindowAllClosed(): void;
  onBeforeQuit(event: { preventDefault(): void }): void | Promise<void>;
}

export function registerGuiBootstrapLifecycle(options: GuiBootstrapLifecycleOptions): void {
  options.app.whenReady().then(options.onReady).catch(options.onReadyError);

  options.app.on('activate', () => {
    if (options.BrowserWindow.getAllWindows().length === 0) {
      options.createWindow();
    }
  });

  options.app.on('window-all-closed', options.onWindowAllClosed);
  options.app.on('before-quit', options.onBeforeQuit);
}
