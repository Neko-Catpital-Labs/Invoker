import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeSessionDriver } from '../claude-session-driver.js';
import type { SessionDriver } from '../session-driver.js';

describe('ClaudeSessionDriver', () => {
  let tmpDir: string;
  let driver: ClaudeSessionDriver;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'claude-driver-test-'));
    driver = new ClaudeSessionDriver();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const sampleClaudeJsonl = [
    JSON.stringify({ type: 'user', message: { content: 'Fix the build error' }, timestamp: '2024-01-01T00:00:00Z' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'I found and fixed the issue.' }] }, timestamp: '2024-01-01T00:00:01Z' }),
  ].join('\n');

  it('parseSession handles Claude JSONL format (user/assistant types)', () => {
    const messages = driver.parseSession(sampleClaudeJsonl);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      role: 'user',
      content: 'Fix the build error',
      timestamp: '2024-01-01T00:00:00Z',
    });
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: 'I found and fixed the issue.',
      timestamp: '2024-01-01T00:00:01Z',
    });
  });

  it('parseSession handles string content (not array)', () => {
    const jsonl = JSON.stringify({
      type: 'assistant',
      message: { content: 'Plain string content' },
      timestamp: 'ts1',
    });
    const messages = driver.parseSession(jsonl);

    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe('Plain string content');
  });

  it('parseSession skips malformed lines', () => {
    const raw = 'not json\n' + sampleClaudeJsonl + '\nalso bad';
    const messages = driver.parseSession(raw);
    expect(messages).toHaveLength(2);
  });

  it('parseSession handles non-string user content by JSON.stringify', () => {
    const jsonl = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'text', text: 'complex' }] },
      timestamp: 'ts1',
    });
    const messages = driver.parseSession(jsonl);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toContain('complex');
  });

  it('processOutput returns rawStdout as-is (no-op storage)', () => {
    const result = driver.processOutput('test-session', 'raw output data');
    expect(result).toBe('raw output data');
  });

  it('has no extractSessionId (Claude provides session ID at spawn)', () => {
    // ClaudeSessionDriver does not define extractSessionId,
    // so the optional interface method is undefined when accessed via SessionDriver.
    const asDriver: SessionDriver = driver;
    expect(asDriver.extractSessionId).toBeUndefined();
  });

  it('loadSession returns null when no session file exists', () => {
    const result = driver.loadSession('nonexistent-session-id-' + Date.now());
    expect(result).toBeNull();
  });

  it('implements SessionDriver interface correctly', () => {
    // Verify all required methods exist
    expect(typeof driver.processOutput).toBe('function');
    expect(typeof driver.loadSession).toBe('function');
    expect(typeof driver.parseSession).toBe('function');
    expect(typeof driver.inspectSession).toBe('function');
    expect(typeof driver.fetchRemoteSession).toBe('function');
  });

  it('inspectSession returns finished when Claude transcript ends with assistant text', () => {
    expect(driver.inspectSession(sampleClaudeJsonl)).toEqual({ state: 'finished' });
  });

  it('inspectSession returns running when Claude transcript ends with a user/tool-result event', () => {
    const jsonl = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] }, timestamp: 'ts0' }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] }, timestamp: 'ts1' }),
    ].join('\n');
    expect(driver.inspectSession(jsonl)).toEqual({ state: 'running' });
  });

  it('inspectSession returns running when Claude transcript ends with assistant tool_use', () => {
    const jsonl = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash' }] },
      timestamp: 'ts1',
    });
    expect(driver.inspectSession(jsonl)).toEqual({ state: 'running' });
  });

  it('inspectSession returns error for malformed content', () => {
    expect(driver.inspectSession('not json')).toEqual({
      state: 'error',
      reason: 'Malformed Claude session JSONL',
    });
  });
});
