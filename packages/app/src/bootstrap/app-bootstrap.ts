import type { App } from 'electron';

export type GuiOwnerPreference = 'auto' | 'daemon' | 'gui';

export function resolveGuiOwnerPreference(env: NodeJS.ProcessEnv = process.env): GuiOwnerPreference {
  const raw = (env.INVOKER_GUI_OWNER_MODE ?? '').trim().toLowerCase();
  if (raw === 'daemon' || raw === 'client' || raw === 'follower') return 'daemon';
  if (raw === 'auto') return 'auto';
  if (raw === 'gui' || raw === 'owner' || raw === 'local') return 'gui';
  if (env.INVOKER_GUI_DAEMON_OWNER === '1') return 'daemon';
  return 'auto';
}

export function guiOwnerBootstrapTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(
    env.INVOKER_GUI_OWNER_BOOTSTRAP_TIMEOUT_MS
      ?? env.INVOKER_HEADLESS_OWNER_BOOTSTRAP_TIMEOUT_MS
      ?? '60000',
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60000;
}

export function formatGuiOwnerBootstrapFallbackMessage(message: string): string {
  return [
    `Daemon owner startup failed: ${message}`,
    'Falling back to local GUI owner mode.',
    'Set INVOKER_GUI_OWNER_MODE=daemon to retry daemon/client mode, or INVOKER_GUI_OWNER_MODE=gui to force local ownership.',
  ].join('\n');
}

export interface EarlyElectronAppOptions {
  app: Pick<App, 'disableHardwareAcceleration' | 'commandLine' | 'name'> & Partial<Pick<App, 'setActivationPolicy' | 'dock'>>;
  platform?: NodeJS.Platform;
  enableTestCompositor: boolean;
  isHeadless: boolean;
}

export function configureEarlyElectronApp(options: EarlyElectronAppOptions): void {
  const platform = options.platform ?? process.platform;

  // Prevent desktop-wide freezes on Linux (Chromium GPU + X11/Wayland compositors).
  // Defense-in-depth: API-level disable, command-line flags, and env var (LIBGL_ALWAYS_SOFTWARE).
  if (platform === 'linux' && !options.enableTestCompositor) {
    options.app.disableHardwareAcceleration();
    options.app.commandLine.appendSwitch('no-sandbox');
    options.app.commandLine.appendSwitch('no-zygote');
    options.app.commandLine.appendSwitch('disable-dev-shm-usage');
    options.app.commandLine.appendSwitch('disable-gpu');
    options.app.commandLine.appendSwitch('disable-gpu-compositing');
    options.app.commandLine.appendSwitch('disable-gpu-sandbox');
    options.app.commandLine.appendSwitch('disable-software-rasterizer');
  }

  // Set app name early so Electron uses "invoker" as WM_CLASS (X11) and app_id (Wayland).
  // --class tells Chromium to set WM_CLASS explicitly, preventing GNOME from
  // grouping Invoker with other Electron apps (e.g. Slack).
  options.app.name = 'invoker';
  if (platform === 'linux') {
    options.app.commandLine.appendSwitch('class', 'invoker');
  }

  if (platform === 'darwin' && options.isHeadless) {
    options.app.setActivationPolicy?.('accessory');
    options.app.dock?.hide();
  }
}

export interface ElectronReadyBootstrapOptions {
  app: Pick<App, 'whenReady'>;
  run: () => Promise<void>;
  onError: (err: unknown) => void;
}

export function runElectronReadyBootstrap(options: ElectronReadyBootstrapOptions): void {
  options.app.whenReady().then(options.run).catch(options.onError);
}

export interface GuiModeLock {
  release: () => void;
}

export interface GuiModeBootstrapOptions {
  app: Pick<App, 'requestSingleInstanceLock' | 'quit'>;
  isTest: boolean;
  setupGuiMode: () => void;
  acquireGuiLock?: () => GuiModeLock | null;
  notifyGuiAlreadyRunning?: () => void;
}

export function startGuiModeBootstrap(options: GuiModeBootstrapOptions): void {
  if (options.isTest) {
    options.setupGuiMode();
    return;
  }

  const gotTheLock = options.app.requestSingleInstanceLock();
  if (!gotTheLock) {
    options.notifyGuiAlreadyRunning?.();
    options.app.quit();
    return;
  }
  const guiLock = options.acquireGuiLock?.();
  if (guiLock === null) {
    options.notifyGuiAlreadyRunning?.();
    options.app.quit();
    return;
  }

  try {
    options.setupGuiMode();
  } catch (err) {
    guiLock?.release();
    throw err;
  }
}

export interface MainProcessBootstrapOptions {
  isHeadless: boolean;
  startHeadlessMode: () => void;
  startGuiMode: () => void;
}

export function startMainProcessBootstrap(options: MainProcessBootstrapOptions): void {
  if (options.isHeadless) {
    options.startHeadlessMode();
    return;
  }

  options.startGuiMode();
}

export interface GuiLifecycleHandlers {
  onWindowAllClosed: () => void;
  onBeforeQuit: (event: { preventDefault: () => void }) => void | Promise<void>;
}

export function registerGuiLifecycleHandlers(
  app: Pick<App, 'on'>,
  handlers: GuiLifecycleHandlers,
): void {
  app.on('window-all-closed', handlers.onWindowAllClosed);
  app.on('before-quit', handlers.onBeforeQuit);
}
