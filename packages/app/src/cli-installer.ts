import { spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

import type { CliInstallerStatus, CliInstallResult } from '@invoker/contracts';

const CLI_BINARY_NAME = 'invoker-cli';

export interface CliInstallerContext {
  isPackaged: boolean;
  /** Path to the version-matched binary bundled in the app resources. */
  bundledCliPath: string;
  appVersion: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  /** Test override for the default install-dir candidates. */
  candidateInstallDirs?: string[];
}

function defaultCandidateInstallDirs(context: CliInstallerContext): string[] {
  const override = context.env.INVOKER_CLI_INSTALL_DIR;
  if (override) return [override];
  if (context.candidateInstallDirs) return context.candidateInstallDirs;
  return ['/usr/local/bin', join(context.homeDir, '.local', 'bin')];
}

function pathDirs(context: CliInstallerContext): string[] {
  return (context.env.PATH ?? '').split(delimiter).filter(Boolean);
}

/**
 * Dirs to scan for an existing install. GUI-launched macOS apps inherit the
 * minimal launchd PATH (`/usr/bin:/bin:...`), so relying on PATH alone would
 * miss installs in /usr/local/bin or ~/.local/bin — always include the
 * well-known locations explicitly.
 */
function searchDirs(context: CliInstallerContext): string[] {
  // An explicit install dir scopes both detection and installation to that
  // one location (used by the hermetic e2e scripts).
  const override = context.env.INVOKER_CLI_INSTALL_DIR;
  if (override) return [override];
  const dirs = [
    ...defaultCandidateInstallDirs(context),
    ...pathDirs(context),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    join(context.homeDir, '.local', 'bin'),
  ];
  return [...new Set(dirs)];
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function probeVersion(binaryPath: string): string | undefined {
  // CRITICAL: spawnSync blocks the Electron main thread. Mirror the
  // detectTool() guard in system-diagnostics.ts — 3s timeout + SIGKILL so a
  // wedged binary cannot stall the app.
  const result = spawnSync(binaryPath, ['--version'], {
    encoding: 'utf8',
    timeout: 3000,
    killSignal: 'SIGKILL',
  });
  if (result.error || result.signal === 'SIGKILL' || result.status !== 0) {
    return undefined;
  }
  const version = (result.stdout ?? '').trim().split('\n')[0]?.trim();
  return version || undefined;
}

export function findInstalledCli(
  context: CliInstallerContext,
): { path: string; version?: string } | null {
  for (const dir of searchDirs(context)) {
    const candidate = join(dir, CLI_BINARY_NAME);
    if (isExecutableFile(candidate)) {
      return { path: candidate, version: probeVersion(candidate) };
    }
  }
  return null;
}

function isWritableDir(dir: string): boolean {
  try {
    const stats = statSync(dir);
    if (!stats.isDirectory()) return false;
    if ((stats.mode & 0o222) === 0) return false;
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function selectInstallDir(
  context: CliInstallerContext,
): { dir: string; warning?: string } | null {
  const candidates = defaultCandidateInstallDirs(context);
  let chosen: string | undefined;
  for (const dir of candidates) {
    if (isWritableDir(dir)) {
      chosen = dir;
      break;
    }
  }
  if (!chosen) {
    // Fall back to creating the last candidate (the user-writable one). Never
    // escalate privileges for the earlier system dirs.
    const fallback = candidates[candidates.length - 1];
    if (!fallback) return null;
    try {
      mkdirSync(fallback, { recursive: true });
    } catch {
      return null;
    }
    if (!isWritableDir(fallback)) return null;
    chosen = fallback;
  }
  const warning = pathDirs(context).includes(chosen)
    ? undefined
    : `${chosen} is not on your PATH. Add it (e.g. export PATH="${chosen}:$PATH") to run ${CLI_BINARY_NAME} from a terminal.`;
  return { dir: chosen, warning };
}

export function writeCliBinary(bundledPath: string, targetPath: string): void {
  // Write-then-rename so an in-use binary is replaced atomically (ETXTBSY
  // guard), and read/write instead of copyFileSync so APFS does not clone
  // extended attributes (quarantine flags) from the app bundle.
  const tmpPath = `${targetPath}.tmp-${process.pid}`;
  try {
    writeFileSync(tmpPath, readFileSync(bundledPath));
    chmodSync(tmpPath, 0o755);
    renameSync(tmpPath, targetPath);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

function isSupported(context: CliInstallerContext): boolean {
  return (
    context.isPackaged &&
    (context.platform === 'darwin' || context.platform === 'linux') &&
    existsSync(context.bundledCliPath)
  );
}

export function resolveCliInstallerStatus(
  context: CliInstallerContext,
  lastInstallError?: string,
): CliInstallerStatus {
  const supported = isSupported(context);
  const installed = supported ? findInstalledCli(context) : null;
  let warning: string | undefined;
  if (installed) {
    const installedDir = dirname(installed.path);
    if (!pathDirs(context).includes(installedDir)) {
      warning = `${installedDir} is not on your PATH. Add it (e.g. export PATH="${installedDir}:$PATH") to run ${CLI_BINARY_NAME} from a terminal.`;
    }
  } else if (supported) {
    warning = selectInstallDir(context)?.warning;
  }
  return {
    supported,
    bundledVersion: context.appVersion,
    installedVersion: installed?.version,
    installedPath: installed?.path,
    upToDate: installed?.version === context.appVersion,
    warning,
    lastInstallError,
  };
}

export function updateInvokerCli(context: CliInstallerContext): CliInstallResult {
  try {
    if (!isSupported(context)) {
      return {
        ok: false,
        updated: false,
        error: 'invoker-cli install is only available in the packaged desktop app.',
        status: resolveCliInstallerStatus(context),
      };
    }
    const installed = findInstalledCli(context);
    if (installed?.version === context.appVersion) {
      return { ok: true, updated: false, installedTo: installed.path, status: resolveCliInstallerStatus(context) };
    }
    // Prefer updating an existing install in place — its dir is already on
    // the user's effective PATH.
    let targetPath: string;
    if (installed) {
      targetPath = installed.path;
    } else {
      const selection = selectInstallDir(context);
      if (!selection) {
        const error = 'No writable install directory found for invoker-cli.';
        return { ok: false, updated: false, error, status: resolveCliInstallerStatus(context, error) };
      }
      targetPath = join(selection.dir, CLI_BINARY_NAME);
    }
    writeCliBinary(context.bundledCliPath, targetPath);
    return { ok: true, updated: true, installedTo: targetPath, status: resolveCliInstallerStatus(context) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, updated: false, error, status: resolveCliInstallerStatus(context, error) };
  }
}

/**
 * Launch hook: silently install/update invoker-cli so packaged-app users get
 * the command on PATH without a manual step. No-op in dev runs and on
 * unsupported platforms.
 */
export function maybeAutoInstallCli(
  context: CliInstallerContext,
  log: (message: string) => void,
): CliInstallResult | null {
  if (!isSupported(context)) return null;
  const result = updateInvokerCli(context);
  if (result.updated) {
    log(`installed invoker-cli ${context.appVersion} to ${result.installedTo}`);
  } else if (!result.ok) {
    log(`invoker-cli auto-install failed: ${result.error}`);
  }
  if (result.status.warning) {
    log(result.status.warning);
  }
  return result;
}
