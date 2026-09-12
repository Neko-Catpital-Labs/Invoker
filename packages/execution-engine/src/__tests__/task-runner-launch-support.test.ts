import { describe, expect, it } from 'vitest';
import { isRetryableSshStartupTransportError } from '../task-runner-launch-support.js';

describe('isRetryableSshStartupTransportError', () => {
  it.each([
    ['exit=255', true],
    ['exit 255', true],
    ['ssh transport failed', true],
    ['connection timed out', true],
    ['operation timed out', true],
    ['connection reset', true],
    ['broken pipe', true],
    ['banner exchange', true],
    ['kex_exchange_identification', true],
    ['remote session terminated unexpectedly', true],
    ['exit=1', false],
    ['ordinary task failure', false],
  ])('%s => %s', (message, expected) => {
    expect(isRetryableSshStartupTransportError(message)).toBe(expected);
  });
});
