import { homedir } from 'node:os';
import { join } from 'node:path';

export interface InvokerHomeEnv {
  INVOKER_DB_DIR?: string;
  INVOKER_IPC_SOCKET?: string;
  INVOKER_REPO_CONFIG_PATH?: string;
  NODE_ENV?: string;
}

export function resolveInvokerHomeRoot(
  env: InvokerHomeEnv = process.env,
  homeDir: string = homedir(),
): string {
  return (
    env.INVOKER_DB_DIR
    ?? (env.NODE_ENV === 'test'
      ? join(homeDir, '.invoker', 'test')
      : join(homeDir, '.invoker'))
  );
}

export function resolveInvokerConfigPath(
  env: InvokerHomeEnv = process.env,
  homeDir: string = homedir(),
): string {
  const override = env.INVOKER_REPO_CONFIG_PATH?.trim();
  return override || join(homeDir, '.invoker', 'config.json');
}

export function resolveInvokerIpcSocketPath(
  env: InvokerHomeEnv = process.env,
  homeDir: string = homedir(),
): string {
  return env.INVOKER_IPC_SOCKET || join(resolveInvokerHomeRoot(env, homeDir), 'ipc-transport.sock');
}
