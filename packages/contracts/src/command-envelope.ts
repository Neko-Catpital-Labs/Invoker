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
