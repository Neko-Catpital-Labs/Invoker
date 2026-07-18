import { join } from 'node:path';
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

export function shouldRefreshGuiOwnerRoute(
  preference: GuiOwnerPreference,
  isUsingDaemonOwner: boolean,
): boolean {
  return preference === 'daemon' || (preference === 'auto' && isUsingDaemonOwner);
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

export type RuntimeModeSnapshot = 'local-owner' | 'daemon-owner' | 'read-only' | 'connection-lost';

export interface RuntimeStatusFields {
  ownerMode: boolean;
  readOnly: boolean;
  mode: RuntimeModeSnapshot;
}

/** Compute the GUI runtime status from ownership flags. */
export function computeGuiRuntimeStatus(input: {
  ownerMode: boolean;
  guiUsingDaemonOwner: boolean;
  connectionLost?: boolean;
}): RuntimeStatusFields {
  const { ownerMode, guiUsingDaemonOwner, connectionLost = false } = input;
  if (ownerMode) {
    return { ownerMode: true, readOnly: false, mode: 'local-owner' };
  }
  if (guiUsingDaemonOwner) {
    return { ownerMode: false, readOnly: false, mode: 'daemon-owner' };
  }
  if (connectionLost) {
    return { ownerMode: false, readOnly: true, mode: 'connection-lost' };
  }
  return { ownerMode: false, readOnly: true, mode: 'read-only' };
}

/** True when an owner IPC/delegation failure means no mutation owner is reachable. */
export function isMutationOwnerUnavailableError(error: unknown): boolean {
  if (error instanceof Error && error.message === 'No mutation owner is available') {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  return code === 'NO_HANDLER'
    || code === 'DISCONNECTED'
    || message.includes('No request handler registered')
    || message.includes('No mutation owner is available');
}

export interface ElectronUserDataEnv {
  INVOKER_USER_DATA_DIR?: string;
  INVOKER_DB_DIR?: string;
  NODE_ENV?: string;
}

export function resolveElectronUserDataDir(env: ElectronUserDataEnv = process.env): string | null {
  if (env.INVOKER_USER_DATA_DIR) return env.INVOKER_USER_DATA_DIR;
  if (env.NODE_ENV === 'test' && env.INVOKER_DB_DIR) {
    return join(env.INVOKER_DB_DIR, 'electron-user-data');
  }
  return null;
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


export interface DaemonOwnerLossState {
  usingDaemonOwner: boolean;
  connectionLost: boolean;
}

export function shouldTreatAsDaemonOwnerLoss(error: unknown): boolean {
  if (isMutationOwnerUnavailableError(error)) return true;
  return error instanceof Error && /Timed out after .* waiting for daemon owner/.test(error.message);
}

export function createDaemonOwnerLossController(options: {
  getState: () => DaemonOwnerLossState;
  setState: (state: DaemonOwnerLossState) => void;
  warn: (message: string) => void;
}) {
  let notify: (() => void) | null = null;
  return {
    setNotify(fn: (() => void) | null) {
      notify = fn;
    },
    markUnavailable(reason: string): void {
      const state = options.getState();
      if (!state.usingDaemonOwner && !state.connectionLost) return;
      options.setState({ usingDaemonOwner: false, connectionLost: true });
      options.warn(`daemon mutation owner unavailable; connection lost: ${reason}`);
      notify?.();
    },
    restoreDaemonOwner(): void {
      options.setState({ usingDaemonOwner: true, connectionLost: false });
      notify?.();
    },
    clearConnectionLost(): void {
      options.setState({ ...options.getState(), connectionLost: false });
    },
  };
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
