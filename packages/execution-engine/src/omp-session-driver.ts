import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentMessage } from './codex-session.js';
import type { AgentSessionInspection, SessionDriver } from './session-driver.js';

const DEFAULT_MAX_STORED_OMP_SESSION_BYTES = 5 * 1024 * 1024;

export class OmpSessionDriver implements SessionDriver {
  processOutput(sessionId: string, rawStdout: string): string {
    const dir = this.getStorageDir();
    const filePath = join(dir, `${sessionId}.omp.txt`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, truncateStoredOmpSession(rawStdout));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[OmpSessionDriver] failed to store session transcript "${filePath}": ${reason}`);
    }
    return rawStdout;
  }

  loadSession(sessionId: string): string | null {
    const filePath = join(this.getStorageDir(), `${sessionId}.omp.txt`);
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, 'utf-8');
  }

  parseSession(raw: string): AgentMessage[] {
    return raw.length > 0 ? [{ role: 'assistant', content: raw, timestamp: '' }] : [];
  }

  inspectSession(raw: string): AgentSessionInspection {
    return raw.length > 0
      ? { state: 'finished' }
      : { state: 'error', reason: 'Empty OMP session output' };
  }

  private getStorageDir(): string {
    const base = process.env.INVOKER_DB_DIR || join(homedir(), '.invoker');
    return join(base, 'agent-sessions');
  }
}

function truncateStoredOmpSession(raw: string): string {
  const maxBytes = resolveMaxStoredOmpSessionBytes();
  if (maxBytes <= 0) return raw;

  if (Buffer.byteLength(raw, 'utf8') <= maxBytes) return raw;

  const marker = '\n\n[Invoker truncated stored OMP session output]\n\n';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  if (markerBytes >= maxBytes) return trimUtf8ToByteLimit(marker, maxBytes);

  let keepChars = Math.max(0, maxBytes - markerBytes);
  let stored = buildStoredOmpSession(raw, marker, keepChars);
  let overflow = Buffer.byteLength(stored, 'utf8') - maxBytes;
  while (overflow > 0 && keepChars > 0) {
    keepChars = Math.max(0, keepChars - Math.max(1, Math.ceil(overflow / 2)));
    stored = buildStoredOmpSession(raw, marker, keepChars);
    overflow = Buffer.byteLength(stored, 'utf8') - maxBytes;
  }
  return stored;
}

function buildStoredOmpSession(raw: string, marker: string, keepChars: number): string {
  const headChars = Math.floor(keepChars / 2);
  const tailChars = keepChars - headChars;
  return `${raw.slice(0, headChars)}${marker}${tailChars > 0 ? raw.slice(-tailChars) : ''}`;
}

function trimUtf8ToByteLimit(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  return Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8');
}

function resolveMaxStoredOmpSessionBytes(): number {
  const raw = process.env.INVOKER_MAX_STORED_OMP_SESSION_BYTES?.trim();
  if (!raw) return DEFAULT_MAX_STORED_OMP_SESSION_BYTES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MAX_STORED_OMP_SESSION_BYTES;
  return parsed;
}
