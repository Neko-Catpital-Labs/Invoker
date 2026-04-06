import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexSessionDriver } from '../codex-session-driver.js';

/**
 * Demonstrates the SSH familiar session storage gap:
 * SSH familiar extracts the session ID but did NOT call processOutput(),
 * so loadSession() returns null for remote sessions.
 *
 * The fix adds a processOutput() call in the SSH familiar's close handler.
 */
describe('SSH session gap (Codex over SSH)', () => {
  let tmpDir: string;
  let origDbDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ssh-session-gap-'));
    origDbDir = process.env.INVOKER_DB_DIR;
    process.env.INVOKER_DB_DIR = tmpDir;
  });

  afterEach(() => {
    if (origDbDir === undefined) delete process.env.INVOKER_DB_DIR;
    else process.env.INVOKER_DB_DIR = origDbDir;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const codexJsonl = [
    JSON.stringify({ type: 'thread.started', thread_id: 'real-codex-thread-id' }),
    JSON.stringify({ timestamp: 'ts1', type: 'event_msg', payload: { type: 'user_message', message: 'Fix the bug' } }),
    JSON.stringify({ timestamp: 'ts2', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed.' }] } }),
  ].join('\n');

  it('OLD flow: extractSessionId without processOutput → loadSession returns null', () => {
    const driver = new CodexSessionDriver();

    // SSH familiar extracts the real ID...
    const realId = driver.extractSessionId(codexJsonl);
    expect(realId).toBe('real-codex-thread-id');

    // ...but never calls processOutput. Session is lost.
    expect(driver.loadSession(realId!)).toBeNull();
  });

  it('FIXED flow: extractSessionId + processOutput → loadSession succeeds', () => {
    const driver = new CodexSessionDriver();

    // SSH familiar extracts the real ID...
    const realId = driver.extractSessionId(codexJsonl);
    expect(realId).toBe('real-codex-thread-id');

    // ...and NOW calls processOutput (the fix).
    driver.processOutput(realId!, codexJsonl);

    // loadSession finds the file.
    const loaded = driver.loadSession(realId!);
    expect(loaded).toBe(codexJsonl);

    // parseSession returns the messages.
    const messages = driver.parseSession(loaded!);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe('user');
    expect(messages[1]!.role).toBe('assistant');
  });
});
