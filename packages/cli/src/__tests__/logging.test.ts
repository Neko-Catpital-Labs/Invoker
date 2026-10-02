import { describe, expect, it, vi } from 'vitest';

import { formatCaughtException, logCaughtException } from '../logging.js';

describe('formatCaughtException', () => {
  it('prints the message without a stack trace', () => {
    const error = new Error('Invalid MCP config at /tmp/mcp.json: expected a JSON object');
    expect(formatCaughtException(error)).toBe(error.message);
  });

  it('stringifies non-Error values', () => {
    expect(formatCaughtException('boom')).toBe('boom');
  });
});

describe('logCaughtException', () => {
  it('writes the stack to stderr for operators', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const error = new Error('shown');
    logCaughtException('install', error);
    const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output).toContain('[invoker-cli] install:');
    expect(output).toContain('shown');
    expect(output).toContain('at ');
    stderr.mockRestore();
  });
});
