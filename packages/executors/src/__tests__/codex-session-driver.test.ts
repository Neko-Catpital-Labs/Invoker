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

  it('parseSession delegates to parseCodexSessionJsonl', () => {
    const driver = new CodexSessionDriver();
    const messages = driver.parseSession(sampleJsonl);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: 'user', content: 'Fix the bug', timestamp: 'ts1' });
    expect(messages[1]).toEqual({ role: 'assistant', content: 'I fixed the bug.', timestamp: 'ts2' });
  });
});
