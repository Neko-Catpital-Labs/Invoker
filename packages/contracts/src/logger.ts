/**
 * Structured logger interface shared across all packages.
 *
 * Each log method accepts a message and an optional bag of structured fields.
 * `child` returns a new Logger with the given bindings merged into every
 * subsequent log entry.
 */
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}
