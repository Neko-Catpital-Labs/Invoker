import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

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

export function childProcessHasExited(child: ChildProcess): boolean {
  return child.exitCode != null || child.signalCode != null;
}

export async function terminateChildProcessGroup(
  child: ChildProcess,
  isComplete: () => boolean,
): Promise<void> {
  if (childProcessHasExited(child) || isComplete()) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const killTimer = setTimeout(() => {
      if (!isComplete()) {
        killProcessGroup(child, 'SIGKILL');
      }
    }, SIGKILL_TIMEOUT_MS);
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve();
    };

    child.once('close', finish);

    if (childProcessHasExited(child) || isComplete()) {
      finish();
      return;
    }

    killProcessGroup(child, 'SIGTERM');
  });
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

function mergePathValues(first?: string, second?: string): string {
  return joinPathEntries(withPrependedUniqueEntries(splitPathEntries(first), splitPathEntries(second)));
}

export function applyMacOSPathFallback(rawPath?: string): string {
  const current = splitPathEntries(rawPath);
  const preferred = process.platform === 'darwin' ? MACOS_PATH_FALLBACK_PREFIXES : [];
  const base = current.length > 0 ? current : MACOS_STANDARD_PATH_ENTRIES;
  return joinPathEntries(withPrependedUniqueEntries(base, preferred));
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

export function resolveExecutableOnCurrentPath(command: string): string | undefined {
  if (command.includes('/') || command.includes('\\')) return command;
  const pathValue = process.env.PATH ?? '';
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return undefined;
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
      const inheritedPath = process.env.PATH;
      const resolvedPath = await probeMacOSShellPath(shell);
      effectivePath = applyMacOSPathFallback(mergePathValues(inheritedPath, resolvedPath));
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
  delete env.INVOKER_REPO_CONFIG_PATH;
  env.PATH = getEffectivePath();
  return env;
}

const AGENT_OUTPUT_DETAIL_MAX_CHARS = 2000;

const CODEX_STDIN_NOISE = /^Reading additional input from stdin\.\.\.$/;

function nonEmptyTrimmedLines(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

/** Drop the benign "Reading additional input from stdin..." lines codex emits when it
 * runs without a controlling TTY. This noise can land on either stdout or stderr
 * depending on the codex version, so every candidate stream is filtered through here. */
function stripCodexStdinNoise(text: string): string {
  return nonEmptyTrimmedLines(text)
    .filter((line) => !CODEX_STDIN_NOISE.test(line))
    .join('\n');
}

function tailChars(text: string): string {
  return text.length <= AGENT_OUTPUT_DETAIL_MAX_CHARS
    ? text
    : text.slice(-AGENT_OUTPUT_DETAIL_MAX_CHARS);
}

export function buildAgentExitFailureDetail(
  rawStdout: string,
  stderr: string,
  displayStdout?: string,
): string {
  const meaningfulStderr = stripCodexStdinNoise(stderr);
  const meaningfulDisplay = stripCodexStdinNoise(displayStdout ?? '');
  const meaningfulStdout = stripCodexStdinNoise(rawStdout);
  const candidate = meaningfulStderr || meaningfulDisplay || meaningfulStdout;
  if (candidate) return tailChars(candidate);

  // Nothing meaningful survived. If the only thing either stream emitted was the
  // benign codex stdin/TTY noise, return an actionable hint instead of echoing it
  // back verbatim (which reads as a pointless error to the user).
  const emittedLines = [...nonEmptyTrimmedLines(stderr), ...nonEmptyTrimmedLines(rawStdout)];
  if (emittedLines.length > 0 && emittedLines.every((line) => CODEX_STDIN_NOISE.test(line))) {
    return 'agent exited non-zero with no captured output, emitting only '
      + '"Reading additional input from stdin..." — a known codex CLI failure when it '
      + 'runs without a controlling TTY (see openai/codex#19945 and #20919). '
      + 'Retry; if it persists, update the codex CLI.';
  }
  return '(no output)';
}
