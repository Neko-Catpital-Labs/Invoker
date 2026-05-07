/**
 * Command Envelope — typed message shape shared by UI, headless, and surfaces.
 */

import { randomUUID } from 'node:crypto';

export type CommandEnvelope<P> = {
  commandId: string;
  source: 'ui' | 'headless' | 'surface';
  scope: 'workflow' | 'task';
  idempotencyKey: string;
  payload: P;
};

export type CommandResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

/**
 * CommandError — Structured error carrying a stable `code` from CommandResult.
 *
 * Thrown by bridge functions so callers can branch on `.code`
 * instead of fragile message-string matching.
 */
export class CommandError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
  }

  /** Create a CommandError from a failed CommandResult's error field. */
  static fromResult(error: { code: string; message: string }): CommandError {
    return new CommandError(error.code, error.message);
  }
}

/**
 * Build a CommandEnvelope with an auto-generated idempotencyKey if none is provided.
 */
export function makeEnvelope<P>(
  commandId: string,
  source: CommandEnvelope<P>['source'],
  scope: CommandEnvelope<P>['scope'],
  payload: P,
  idempotencyKey?: string,
): CommandEnvelope<P> {
  return { commandId, source, scope, idempotencyKey: idempotencyKey ?? randomUUID(), payload };
}
