import type { Logger } from '@invoker/contracts';

function isNodeErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && typeof (value as NodeJS.ErrnoException).code === 'string';
}

export function isBrokenPipeError(value: unknown): boolean {
  if (!isNodeErrnoException(value)) return false;
  return value.code === 'EPIPE' || value.code === 'ERR_STREAM_DESTROYED';
}

export interface ProcessErrorHandlerDeps {
  logger: Pick<Logger, 'error' | 'warn'>;
  fallbackConsole?: Pick<Console, 'error'>;
}

export function logProcessError(
  kind: 'uncaughtException' | 'unhandledRejection',
  reason: unknown,
  deps: ProcessErrorHandlerDeps,
): void {
  const message = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  if (isBrokenPipeError(reason)) {
    deps.logger.warn(`${kind}: suppressed broken pipe (${reason instanceof Error ? reason.message : String(reason)})`, {
      module: 'process',
      code: isNodeErrnoException(reason) ? reason.code : undefined,
    });
    return;
  }

  try {
    deps.logger.error(`${kind}: ${message}`, { module: 'process' });
  } catch {
    deps.fallbackConsole?.error('[process] error handler failed:', reason);
  }
}
