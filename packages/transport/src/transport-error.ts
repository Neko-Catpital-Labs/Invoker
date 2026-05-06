/**
 * TransportErrorCode — Stable error codes for the IPC bus error envelope.
 *
 * These codes replace message-string matching for control flow.
 * Consumers (delegation layer, API bridge) switch on `code` instead of
 * parsing `.message`.
 */
export const TransportErrorCode = {
  /** No handler is registered for the requested channel. */
  NO_HANDLER: 'NO_HANDLER',
  /** The IPC bus has been disconnected. */
  DISCONNECTED: 'DISCONNECTED',
  /** The request handler threw an unclassified error. */
  HANDLER_ERROR: 'HANDLER_ERROR',
  /** The request exceeded its deadline without receiving a response. */
  REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
} as const;

export type TransportErrorCode = (typeof TransportErrorCode)[keyof typeof TransportErrorCode];

/**
 * TransportError — Structured error carrying a stable `code` field.
 *
 * Thrown by IpcBus and LocalBus so callers can branch on `.code`
 * without fragile message-string matching.
 */
export class TransportError extends Error {
  readonly code: TransportErrorCode;

  constructor(code: TransportErrorCode, message: string) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
  }
}
