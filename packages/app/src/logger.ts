/**
 * Concrete Logger that writes JSON-lines to ~/.invoker/invoker.log
 * and mirrors structured records into the sqlite activity_log.
 *
 * Does NOT monkey-patch the global `console` object.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

import type { Logger } from '@invoker/contracts';
import type { SQLiteAdapter } from '@invoker/data-store';

const LOG_PATH = path.join(homedir(), '.invoker', 'invoker.log');

type Level = 'debug' | 'info' | 'warn' | 'error';

export interface FileAndDbLoggerOptions {
  /** SQLiteAdapter instance for activity_log writes. Omit to skip DB writes. */
  persistence?: SQLiteAdapter;
  /** Override the default log file path (mainly for tests). */
  filePath?: string;
}

export class FileAndDbLogger implements Logger {
  private readonly bindings: Record<string, unknown>;
  private readonly persistence: SQLiteAdapter | undefined;
  private readonly filePath: string;
  private dirEnsured = false;

  constructor(
    bindings: Record<string, unknown>,
    options: FileAndDbLoggerOptions = {},
  ) {
    this.bindings = bindings;
    this.persistence = options.persistence;
    this.filePath = options.filePath ?? LOG_PATH;
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.emit('debug', msg, fields);
  }

  info(msg: string, fields?: Record<string, unknown>): void {
    this.emit('info', msg, fields);
  }

  warn(msg: string, fields?: Record<string, unknown>): void {
    this.emit('warn', msg, fields);
  }

  error(msg: string, fields?: Record<string, unknown>): void {
    this.emit('error', msg, fields);
  }

  child(childBindings: Record<string, unknown>): Logger {
    return new FileAndDbLogger(
      { ...this.bindings, ...childBindings },
      { persistence: this.persistence, filePath: this.filePath },
    );
  }

  // ── internals ────────────────────────────────────────

  private emit(
    level: Level,
    msg: string,
    fields?: Record<string, unknown>,
  ): void {
    const merged = { ...this.bindings, ...fields };
    const record = {
      time: new Date().toISOString(),
      level,
      msg,
      ...merged,
    };

    this.writeFile(record);
    this.writeDb(level, merged, msg);
  }

  private writeFile(record: Record<string, unknown>): void {
    try {
      if (!this.dirEnsured) {
        mkdirSync(path.dirname(this.filePath), { recursive: true });
        this.dirEnsured = true;
      }
      appendFileSync(this.filePath, JSON.stringify(record) + '\n');
    } catch {
      /* Logging must never crash the app. */
    }
  }

  private writeDb(
    level: string,
    merged: Record<string, unknown>,
    msg: string,
  ): void {
    if (!this.persistence) return;
    try {
      const source = String(merged.module ?? 'app');
      this.persistence.writeActivityLog(source, level, msg);
    } catch {
      /* DB write failure must not propagate. */
    }
  }
}
