import { describe, expect, it, vi } from 'vitest';

import { logProcessError } from '../process-error-handling.js';

describe('process error handling', () => {
  it('suppresses broken-pipe uncaught exceptions instead of feeding a log loop', () => {
    const logger = {
      warn: vi.fn(),
      error: vi.fn(),
    };
    const fallbackConsole = { error: vi.fn() };
    const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

    logProcessError('uncaughtException', error, { logger, fallbackConsole });

    expect(logger.warn).toHaveBeenCalledWith(
      'uncaughtException: suppressed broken pipe (write EPIPE)',
      { module: 'process', code: 'EPIPE' },
    );
    expect(logger.error).not.toHaveBeenCalled();
    expect(fallbackConsole.error).not.toHaveBeenCalled();
  });

  it('still logs non-pipe process failures as errors', () => {
    const logger = {
      warn: vi.fn(),
      error: vi.fn(),
    };

    logProcessError('unhandledRejection', new Error('boom'), { logger });

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('unhandledRejection: Error: boom'), { module: 'process' });
  });
});
