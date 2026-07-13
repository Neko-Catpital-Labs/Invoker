import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

export function resolveBundledCliPath(context: {
  isPackaged: boolean;
  resourcesPath?: string;
  appDir?: string;
}): string {
  if (context.isPackaged) {
    const resourcesPath = context.resourcesPath ?? process.resourcesPath;
    return join(resourcesPath, 'invoker-cli', 'invoker-cli');
  }

  return join(context.appDir ?? process.cwd(), '..', 'cli', 'dist', 'index.js');
}

export function assertBundledCliAvailable(cliPath: string): void {
  if (!existsSync(cliPath)) {
    throw new Error(`Bundled invoker-cli helper not found at ${cliPath}. Build @invoker/cli before packaging.`);
  }
}

export function spawnBundledCli(
  cliPath: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    dbDir?: string;
    configPath?: string;
    cwd?: string;
  } = {},
): ChildProcess {
  assertBundledCliAvailable(cliPath);
  const runtime = cliPath.endsWith('.js') ? process.execPath : cliPath;
  const cliArgs = [
    ...(cliPath.endsWith('.js') ? [cliPath] : []),
    ...args,
    ...(options.dbDir ? ['--db-dir', options.dbDir] : []),
    ...(options.configPath ? ['--config', options.configPath] : []),
  ];
  return spawn(runtime, cliArgs, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
