/**
 * Build shell strings for opening an external terminal (Terminal.app / x-terminal-emulator).
 * Uses POSIX single-quote escaping so argv boundaries are preserved (critical for `bash -c`).
 */

import { spawn, type SpawnOptions } from 'node:child_process';
import { normalizeTerminalDisplayBridge, type TerminalSpec } from '@invoker/execution-engine';

type TerminalShellSpec = Pick<TerminalSpec, 'cwd' | 'command' | 'args' | 'displayBridge'>;
type LinuxTerminalShellSpec = TerminalShellSpec & Pick<TerminalSpec, 'linuxTerminalTail'>;

/** Escape one argument for POSIX shell single-quoted strings. */
export function shellSingleQuoteForPOSIX(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Escape display text for bash/zsh ANSI-C quoted strings. */
export function shellAnsiCQuoteForBashLike(s: string): string {
  return `$'${s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')}'`;
}

export type InteractiveExecShell = 'bash' | 'zsh';

function buildDisplayBridgePrintf(displayBridge: string | undefined): string | undefined {
  const bridge = normalizeTerminalDisplayBridge(displayBridge);
  return bridge === undefined ? undefined : `printf '%s' ${shellAnsiCQuoteForBashLike(bridge)}`;
}

/**
 * Full shell line: `cd '<cwd>' && ...` plus either `exec bash` / `exec zsh` or `command` with args properly quoted.
 */
export function buildTerminalShellCommand(
  spec: TerminalShellSpec,
  defaultCwd: string,
  options?: { interactiveExec?: InteractiveExecShell },
): string {
  const cwd = spec.cwd ?? defaultCwd;
  const cd = `cd ${shellSingleQuoteForPOSIX(cwd)}`;
  let invocation: string;
  if (!spec.command) {
    const execSh = options?.interactiveExec === 'zsh' ? 'exec zsh' : 'exec bash';
    invocation = execSh;
  } else {
    const argv = [spec.command, ...(spec.args ?? [])];
    invocation = argv.map(shellSingleQuoteForPOSIX).join(' ');
  }
  const bridgePrintf = buildDisplayBridgePrintf(spec.displayBridge);
  if (!bridgePrintf) return `${cd} && ${invocation}`;
  return `${cd} && { ${bridgePrintf}; ${invocation}; }`;
}

/** Escape for embedding in AppleScript: `tell application "Terminal" to do script "…"`. */
export function appleScriptEscapeForDoubleQuotedString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** argv for `osascript` to run the built shell command in Terminal.app. */
export function buildMacOSOsascriptArgs(
  spec: TerminalShellSpec,
  defaultCwd: string,
): string[] {
  const shellCmd = buildTerminalShellCommand(spec, defaultCwd, { interactiveExec: 'zsh' });
  const escaped = appleScriptEscapeForDoubleQuotedString(shellCmd);
  return [
    '-e', 'tell application "Terminal"',
    '-e', 'activate',
    '-e', `do script "${escaped}"`,
    '-e', 'end tell',
  ];
}

/**
 * Inner script passed to `bash -c` for Linux x-terminal-emulator (includes optional suffix).
 */
export function buildLinuxXTerminalBashScript(
  spec: LinuxTerminalShellSpec,
  defaultCwd: string,
): string {
  const base = buildTerminalShellCommand(spec, defaultCwd);
  if (!spec.command) {
    return base;
  }
  const tail = spec.linuxTerminalTail ?? (spec.command === 'claude' || spec.command === 'codex' ? 'exec_bash' : 'pause');
  const suffix = tail === 'exec_bash'
    ? '; exec bash'
    : '; echo ""; echo "Exit code: $?"; echo "Press Enter to close..."; read';
  return base + suffix;
}

export type OpenTerminalResult = { opened: boolean; reason?: string };

/**
 * Spawn a detached process; resolve `{ opened: true }` after successful spawn, or `{ opened: false, reason }`
 * on spawn error (e.g. executable missing).
 */
export function spawnDetachedTerminal(
  command: string,
  args: string[],
  options: Omit<SpawnOptions, 'detached' | 'stdio'>,
  onClose: () => void,
): Promise<OpenTerminalResult> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        ...options,
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      resolve({ opened: false, reason });
      return;
    }
    const finish = (opened: boolean, reason?: string) => {
      if (settled) return;
      settled = true;
      resolve(opened ? { opened: true } : { opened: false, reason });
    };
    child.once('error', (err) => finish(false, err.message));
    // Capture stderr for diagnostics (e.g. osascript errors)
    let stderr = '';
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    }
    child.once('spawn', () => {
      child.on('close', (code) => {
        if (stderr) process.stderr.write(`[spawn-terminal] ${command} stderr: ${stderr.trim()}\n`);
        if (code && code !== 0) process.stderr.write(`[spawn-terminal] ${command} exited with code ${code}\n`);
        onClose();
      });
      child.unref();
      finish(true);
    });
  });
}
