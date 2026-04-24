import { spawn, type ChildProcess } from 'node:child_process';

export const SIGKILL_TIMEOUT_MS = 5_000;
const SHELL_ENV_RESOLUTION_TIMEOUT_MS = 10_000;
const SHELL_ENV_MARKER_START = '__INVOKER_EFFECTIVE_PATH_START__';
const SHELL_ENV_MARKER_END = '__INVOKER_EFFECTIVE_PATH_END__';
export const INVOKER_RESOLVING_ENVIRONMENT = 'INVOKER_RESOLVING_ENVIRONMENT';

const MACOS_PATH_FALLBACK_PREFIXES = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
];

const MACOS_STANDARD_PATH_ENTRIES = [
  '/usr/local/sbin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];

export interface ShellEnvironmentInitResult {
  status: 'resolved' | 'fallback' | 'skipped';
  path: string;
  shell: string;
  reason?: string;
}

let effectivePath = applyMacOSPathFallback(process.env.PATH);
let initializationPromise: Promise<ShellEnvironmentInitResult> | null = null;
let initializationResult: ShellEnvironmentInitResult | null = null;

/**
 * Sends a signal to the entire process group.
 * Uses negative PID to target the group when the process was spawned with detached: true.
 */
export function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (child.pid == null) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return child.kill(signal);
  }
}

function splitPathEntries(rawPath?: string): string[] {
  if (!rawPath) return [];
  return rawPath.split(':').map((entry) => entry.trim()).filter(Boolean);
}

function joinPathEntries(entries: string[]): string {
  return entries.join(':');
}

function withPrependedUniqueEntries(prefixes: string[], rest: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const entry of [...prefixes, ...rest]) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    ordered.push(entry);
  }
  return ordered;
}

export function applyMacOSPathFallback(rawPath?: string): string {
  const current = splitPathEntries(rawPath);
  const preferred = process.platform === 'darwin' ? MACOS_PATH_FALLBACK_PREFIXES : [];
  const fallback = current.length > 0 ? current : MACOS_STANDARD_PATH_ENTRIES;
  return joinPathEntries(withPrependedUniqueEntries(preferred, fallback));
}

export function parseResolvedShellPath(output: string): string | null {
  const start = output.lastIndexOf(SHELL_ENV_MARKER_START);
  if (start === -1) return null;
  const payloadStart = start + SHELL_ENV_MARKER_START.length;
  const end = output.indexOf(SHELL_ENV_MARKER_END, payloadStart);
  if (end === -1) return null;
  const resolved = output.slice(payloadStart, end).trim();
  return resolved.length > 0 ? resolved : null;
}

export function getEffectivePath(): string {
  return effectivePath;
}

export async function probeMacOSShellPath(shell: string, timeoutMs = SHELL_ENV_RESOLUTION_TIMEOUT_MS): Promise<string> {
  const probeScript = `printf '%s%s%s' '${SHELL_ENV_MARKER_START}' "$PATH" '${SHELL_ENV_MARKER_END}'`;

  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      fn();
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, ['-i', '-l', '-c', probeScript], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          [INVOKER_RESOLVING_ENVIRONMENT]: '1',
        },
      });
    } catch (err) {
      reject(err);
      return;
    }

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (code, signal) => {
      finish(() => {
        const combinedOutput = `${stdout}${stderr}`;
        const resolved = parseResolvedShellPath(combinedOutput);
        if (resolved) {
          resolve(resolved);
          return;
        }
        const reason = code === 0
          ? `shell probe did not emit a PATH marker`
          : `shell probe exited with code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}`;
        reject(new Error(reason));
      });
    });

    timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error(`shell environment resolution timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
  });
}

export async function initializeShellEnvironment(): Promise<ShellEnvironmentInitResult> {
  if (initializationResult) return initializationResult;
  if (initializationPromise) return await initializationPromise;

  initializationPromise = (async () => {
    const shell = process.env.SHELL?.trim() || '/bin/zsh';
    if (process.platform !== 'darwin') {
      initializationResult = {
        status: 'skipped',
        path: effectivePath,
        shell,
        reason: 'shell environment resolution is only used on macOS',
      };
      return initializationResult;
    }

    try {
      const resolvedPath = await probeMacOSShellPath(shell);
      effectivePath = applyMacOSPathFallback(resolvedPath);
      process.env.PATH = effectivePath;
      initializationResult = {
        status: 'resolved',
        path: effectivePath,
        shell,
      };
      return initializationResult;
    } catch (err) {
      effectivePath = applyMacOSPathFallback(process.env.PATH);
      process.env.PATH = effectivePath;
      initializationResult = {
        status: 'fallback',
        path: effectivePath,
        shell,
        reason: err instanceof Error ? err.message : String(err),
      };
      return initializationResult;
    }
  })();

  return await initializationPromise;
}

export function resetShellEnvironmentForTests(): void {
  effectivePath = applyMacOSPathFallback(process.env.PATH);
  initializationPromise = null;
  initializationResult = null;
}

/** Strip Electron-specific env vars so child processes use the system Node.js. */
export function cleanElectronEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ASAR;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  env.PATH = getEffectivePath();
  return env;
}
