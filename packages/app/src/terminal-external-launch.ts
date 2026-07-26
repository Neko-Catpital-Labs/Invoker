/**
 * Build shell strings for opening an external terminal (Terminal.app / x-terminal-emulator).
 * Uses POSIX single-quote escaping so argv boundaries are preserved (critical for `bash -c`).
 */

import { spawn, type SpawnOptions } from 'node:child_process';
import {
  MAX_TERMINAL_DISPLAY_BRIDGE_CHARS,
  type TerminalSpec,
} from '@invoker/execution-engine';

/** Escape one argument for POSIX shell single-quoted strings. */
export function shellSingleQuoteForPOSIX(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export type InteractiveExecShell = 'bash' | 'zsh';
type ExternalTerminalSpec = Pick<
  TerminalSpec,
  'cwd' | 'command' | 'args' | 'linuxTerminalTail' | 'displayBridgeText'
>;

/**
 * Full shell line: `cd '<cwd>' && ...` plus either `exec bash` / `exec zsh` or `command` with args properly quoted.
 */
export function buildTerminalShellCommand(
  spec: ExternalTerminalSpec,
  defaultCwd: string,
  options?: { interactiveExec?: InteractiveExecShell },
): string {
  const cwd = spec.cwd ?? defaultCwd;
  const cd = `cd ${shellSingleQuoteForPOSIX(cwd)}`;
  const bridge = buildDisplayBridgeCommand(spec.displayBridgeText);
  if (!spec.command) {
    const execSh = options?.interactiveExec === 'zsh' ? 'exec zsh' : 'exec bash';
    if (!bridge) return `${cd} && ${execSh}`;
    return `${cd} && { ${bridge}; ${execSh}; }`;
  }
  const argv = [spec.command, ...(spec.args ?? [])];
  const commandLine = argv.map(shellSingleQuoteForPOSIX).join(' ');
  if (!bridge) return `${cd} && ${commandLine}`;
  return `${cd} && { ${bridge}; ${commandLine}; }`;
}

/** Escape for embedding in AppleScript: `tell application "Terminal" to do script "…"`. */
export function appleScriptEscapeForDoubleQuotedString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** argv for `osascript` to run the built shell command in Terminal.app. */
export function buildMacOSOsascriptArgs(
  spec: ExternalTerminalSpec,
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
  spec: ExternalTerminalSpec,
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

function buildDisplayBridgeCommand(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const bounded = normalized.slice(0, MAX_TERMINAL_DISPLAY_BRIDGE_CHARS);
  return `printf '%s\\n' ${shellSingleQuoteForPOSIX(bounded)} || true`;
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
