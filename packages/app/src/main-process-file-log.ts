/**
 * Mirror main-process console output to ~/.invoker/invoker.log.
 *
 * Side-effect module: importing it patches console.log/info/warn/error
 * so every call also appends to the log file. Terminal output is preserved.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import * as util from 'node:util';

const LEVELS: Array<'log' | 'info' | 'warn' | 'error'> = ['log', 'info', 'warn', 'error'];

export function installMainConsoleFileMirror(): void {
  const logPath = path.join(homedir(), '.invoker', 'invoker.log');
  let dirEnsured = false;
  let reentrant = false;

  for (const level of LEVELS) {
    const original = console[level].bind(console);

    console[level] = (...args: unknown[]) => {
      original(...args);

      if (reentrant) return;
      reentrant = true;
      try {
        if (!dirEnsured) {
          mkdirSync(path.dirname(logPath), { recursive: true });
          dirEnsured = true;
        }
        const tag = level === 'log' ? 'info' : level;
        const line = `${new Date().toISOString()} [main] ${tag}: ${util.format(...args)}\n`;
        appendFileSync(logPath, line);
      } catch {
        /* ignore — don't break the app for a logging failure */
      } finally {
        reentrant = false;
      }
    };
  }
}

/* Auto-install unless opted out or running tests. */
if (
  process.env.INVOKER_DISABLE_MAIN_LOG_MIRROR !== '1' &&
  process.env.NODE_ENV !== 'test'
) {
  installMainConsoleFileMirror();
}
