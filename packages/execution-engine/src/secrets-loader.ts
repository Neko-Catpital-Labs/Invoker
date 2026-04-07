/**
 * Minimal dotenv-style secrets loader.
 *
 * Reads a file containing `KEY=value` lines and returns an array of
 * `KEY=value` strings suitable for passing to Docker's `Env` array.
 *
 * Security: the file must be chmod 600 or 400 (no group/other bits set).
 * The loader refuses to read files with looser permissions.
 *
 * Format:
 *   - `KEY=value` per line
 *   - `#` starts a comment
 *   - Blank lines are ignored
 *   - Optional single or double quotes are stripped from values
 *   - No multiline values, no variable interpolation
 */

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2));
  return path;
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Load a secrets file as an array of `KEY=value` env entries.
 *
 * Returns `[]` when:
 *   - `path` is undefined
 *   - the file does not exist
 *
 * Throws when:
 *   - the file exists but group or other permission bits are set
 *   - a line is malformed (not `KEY=VALUE`)
 *   - a key is empty or contains invalid characters
 */
export function loadSecretsFile(path: string | undefined): string[] {
  if (!path) return [];
  const expanded = expandHome(path);

  let stat;
  try {
    stat = statSync(expanded);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }

  // Enforce chmod 600 or 400: no group/other bits may be set.
  const mode = stat.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `Secrets file ${expanded} has insecure permissions ${mode.toString(8)}. ` +
      `Run: chmod 600 ${expanded}`,
    );
  }

  const raw = readFileSync(expanded, 'utf-8');
  const lines = raw.split('\n');
  const entries: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) {
      throw new Error(`${expanded}:${i + 1}: expected KEY=VALUE`);
    }

    const key = line.slice(0, eq).trim();
    const value = stripQuotes(line.slice(eq + 1).trim());

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`${expanded}:${i + 1}: invalid key "${key}"`);
    }

    entries.push(`${key}=${value}`);
  }

  return entries;
}
