import { createHash } from 'node:crypto';
import { homedir, platform as osPlatform } from 'node:os';
import { join, resolve } from 'node:path';

export type InvokerRuntimeKind = 'packaged' | 'source-development' | 'test';

const INVOKER_RUNTIME_KINDS: readonly InvokerRuntimeKind[] = ['packaged', 'source-development', 'test'];

export interface InvokerInstanceProfileEnv {
  INVOKER_DB_DIR?: string;
  INVOKER_IPC_SOCKET?: string;
  INVOKER_REPO_CONFIG_PATH?: string;
  INVOKER_USER_DATA_DIR?: string;
  INVOKER_ENV_PATH?: string;
  INVOKER_LOG_PATH?: string;
  INVOKER_API_PORT?: string;
  INVOKER_WEB_PORT?: string;
  APPDATA?: string;
  XDG_CONFIG_HOME?: string;
}

export interface InvokerInstanceProfileInput {
  kind: string;
  sourceRoot?: string;
  env?: InvokerInstanceProfileEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

export interface InvokerInstancePortPolicy {
  apiPort: number;
  webPort: number;
}

export interface InvokerInstanceProfile {
  kind: InvokerRuntimeKind;
  developmentId: string | null;
  isProductionAccessExplicit: boolean;
  homeRoot: string;
  electronUserDataDir: string;
  ipcSocketPath: string;
  configPath: string;
  envPath: string;
  logPath: string;
  ports: InvokerInstancePortPolicy;
}

export class InvokerInstanceProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvokerInstanceProfileError';
  }
}

const PRODUCTION_API_PORT = 4100;
const PRODUCTION_WEB_PORT = 4200;
const DEVELOPMENT_API_PORT_BASE = 41000;
const DEVELOPMENT_PORT_SPAN = 900;
const DEVELOPMENT_WEB_PORT_OFFSET = 1000;

function isInvokerRuntimeKind(value: string): value is InvokerRuntimeKind {
  return (INVOKER_RUNTIME_KINDS as readonly string[]).includes(value);
}

function hashSourceRoot(sourceRoot: string): string {
  return createHash('sha256').update(resolve(sourceRoot)).digest('hex').slice(0, 10);
}

function derivePortFromDevelopmentId(developmentId: string): number {
  const numeric = parseInt(developmentId.slice(0, 8), 16);
  return DEVELOPMENT_API_PORT_BASE + (numeric % DEVELOPMENT_PORT_SPAN);
}

function defaultElectronUserDataDir(
  platformName: NodeJS.Platform,
  homeDir: string,
  env: InvokerInstanceProfileEnv,
): string {
  const productName = 'Invoker';
  if (platformName === 'darwin') {
    return join(homeDir, 'Library', 'Application Support', productName);
  }
  if (platformName === 'win32') {
    return join(env.APPDATA ?? join(homeDir, 'AppData', 'Roaming'), productName);
  }
  return join(env.XDG_CONFIG_HOME ?? join(homeDir, '.config'), productName);
}

export function resolveInvokerInstanceProfile(input: InvokerInstanceProfileInput): InvokerInstanceProfile {
  const {
    kind: rawKind,
    sourceRoot,
    env = {},
    platform: platformName = osPlatform(),
    homeDir = homedir(),
  } = input;

  if (!isInvokerRuntimeKind(rawKind)) {
    throw new InvokerInstanceProfileError(
      `Unknown Invoker runtime profile "${rawKind}". Expected one of: ${INVOKER_RUNTIME_KINDS.join(', ')}.`,
    );
  }
  const kind = rawKind;

  if (kind === 'source-development' && !sourceRoot?.trim()) {
    throw new InvokerInstanceProfileError('A source-development profile requires a non-empty sourceRoot.');
  }

  const developmentId = kind === 'source-development' ? hashSourceRoot(sourceRoot!) : null;

  const homeRoot = env.INVOKER_DB_DIR
    ?? (kind === 'test'
      ? join(homeDir, '.invoker', 'test')
      : kind === 'source-development'
        ? join(homeDir, '.invoker', 'dev', developmentId!)
        : join(homeDir, '.invoker'));

  const ipcSocketPath = env.INVOKER_IPC_SOCKET ?? join(homeRoot, 'ipc-transport.sock');
  const configPath = env.INVOKER_REPO_CONFIG_PATH?.trim() || join(homeRoot, 'config.json');
  const envPath = env.INVOKER_ENV_PATH ?? join(homeRoot, '.env');
  const logPath = env.INVOKER_LOG_PATH ?? join(homeRoot, 'invoker.log');

  const electronUserDataDir = env.INVOKER_USER_DATA_DIR
    ?? (kind === 'packaged'
      ? defaultElectronUserDataDir(platformName, homeDir, env)
      : join(homeRoot, 'electron'));

  const ports: InvokerInstancePortPolicy = kind === 'packaged'
    ? {
      apiPort: env.INVOKER_API_PORT ? parseInt(env.INVOKER_API_PORT, 10) : PRODUCTION_API_PORT,
      webPort: env.INVOKER_WEB_PORT ? parseInt(env.INVOKER_WEB_PORT, 10) : PRODUCTION_WEB_PORT,
    }
    : kind === 'test'
      ? { apiPort: 0, webPort: 0 }
      : (() => {
        const apiPort = derivePortFromDevelopmentId(developmentId!);
        return { apiPort, webPort: apiPort + DEVELOPMENT_WEB_PORT_OFFSET };
      })();

  return {
    kind,
    developmentId,
    isProductionAccessExplicit: kind === 'packaged',
    homeRoot,
    electronUserDataDir,
    ipcSocketPath,
    configPath,
    envPath,
    logPath,
    ports,
  };
}
