import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexSessionDriver } from '../codex-session-driver.js';

describe('CodexSessionDriver', () => {
  let tmpDir: string;
  let origDbDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'codex-driver-test-'));
    origDbDir = process.env.INVOKER_DB_DIR;
    process.env.INVOKER_DB_DIR = tmpDir;
  });

  afterEach(() => {
    if (origDbDir === undefined) delete process.env.INVOKER_DB_DIR;
    else process.env.INVOKER_DB_DIR = origDbDir;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const sampleJsonl = [
    JSON.stringify({ timestamp: 'ts1', type: 'event_msg', payload: { type: 'user_message', message: 'Fix the bug' } }),
    JSON.stringify({ timestamp: 'ts2', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I fixed the bug.' }] } }),
  ].join('\n');

  it('processOutput stores raw JSONL and returns readable text', () => {
    const driver = new CodexSessionDriver();
    const readable = driver.processOutput('sess-001', sampleJsonl);

    // Verify file was stored
    const storedPath = join(tmpDir, 'agent-sessions', 'sess-001.jsonl');
    expect(existsSync(storedPath)).toBe(true);
    expect(readFileSync(storedPath, 'utf-8')).toBe(sampleJsonl);

    // Verify readable text contains user and assistant messages
    expect(readable).toContain('Fix the bug');
    expect(readable).toContain('I fixed the bug.');
  });

  it('loadSession returns stored content by ID', () => {
    const driver = new CodexSessionDriver();
    driver.processOutput('sess-002', sampleJsonl);

    const loaded = driver.loadSession('sess-002');
    expect(loaded).toBe(sampleJsonl);
  });

  it('loadSession returns null for missing session', () => {
    const driver = new CodexSessionDriver();
    expect(driver.loadSession('nonexistent')).toBeNull();
  });

  it('extractSessionId returns real codex thread ID from JSONL', () => {
    const driver = new CodexSessionDriver();
    const jsonl = [
      JSON.stringify({ type: 'thread.started', thread_id: '019d5086-675d-7823-b866-ac320c5d689f' }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Hello' } }),
    ].join('\n');

    expect(driver.extractSessionId(jsonl)).toBe('019d5086-675d-7823-b866-ac320c5d689f');
  });

  it('extractSessionId returns undefined when no thread.started', () => {
    const driver = new CodexSessionDriver();
    expect(driver.extractSessionId(sampleJsonl)).toBeUndefined();
  });

  it('parseSession delegates to parseCodexSessionJsonl', () => {
    const driver = new CodexSessionDriver();
    const messages = driver.parseSession(sampleJsonl);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: 'user', content: 'Fix the bug', timestamp: 'ts1' });
    expect(messages[1]).toEqual({ role: 'assistant', content: 'I fixed the bug.', timestamp: 'ts2' });
  });

  it('inspectSession returns finished when turn.completed is present', () => {
    const driver = new CodexSessionDriver();
    const jsonl = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }),
    ].join('\n');
    expect(driver.inspectSession(jsonl)).toEqual({ state: 'finished' });
  });

  it('inspectSession returns running when session has started but not completed', () => {
    const driver = new CodexSessionDriver();
    const jsonl = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({ type: 'item.started', item: { id: 'item-1', status: 'in_progress' } }),
    ].join('\n');
    expect(driver.inspectSession(jsonl)).toEqual({ state: 'running' });
  });

  it('inspectSession returns error for malformed content', () => {
    const driver = new CodexSessionDriver();
    expect(driver.inspectSession('not json')).toEqual({
      state: 'error',
      reason: 'Malformed Codex session JSONL',
    });
  });

  it('loadSession finds file when processOutput uses extracted real ID (fixed flow)', () => {
    const driver = new CodexSessionDriver();
    const jsonl = [
      JSON.stringify({ type: 'thread.started', thread_id: 'real-thread-id' }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Fix it' } }),
    ].join('\n');

    // Simulate the FIXED flow: extract real ID first, then write under it
    const realId = driver.extractSessionId(jsonl) ?? 'local-uuid';
    driver.processOutput(realId, jsonl);

    // loadSession with real ID should find the file
    expect(driver.loadSession('real-thread-id')).toBe(jsonl);
  });

  it('loadSession FAILS when processOutput uses local UUID but load uses real ID (documents the bug)', () => {
    const driver = new CodexSessionDriver();
    const jsonl = [
      JSON.stringify({ type: 'thread.started', thread_id: 'real-thread-id' }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Fix it' } }),
    ].join('\n');

    // Simulate the OLD buggy flow: write with local UUID first
    driver.processOutput('local-uuid', jsonl);

    // Load with real ID — file not found (this documents the bug)
    expect(driver.loadSession('real-thread-id')).toBeNull();
    // But loading with local UUID works
    expect(driver.loadSession('local-uuid')).toBe(jsonl);
  });
});
