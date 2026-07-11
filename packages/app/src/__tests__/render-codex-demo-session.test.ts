import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderCodexDemoSession } from '../../e2e/fixtures/render-codex-demo-session.mjs';

describe('renderCodexDemoSession', () => {
  it('renders user and agent messages from the persisted session JSONL', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-demo-session-'));
    const sessionDir = join(root, 'agent-sessions');
    mkdirSync(sessionDir, { recursive: true });
    const sessionId = 'codex-demo-checkout-contract';
    const sessionFile = join(sessionDir, `${sessionId}.jsonl`);
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: 'thread.started', thread_id: sessionId }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'user_message',
            text: 'Design the checkout session API contract and OpenAPI types.',
          },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: 'Checkout session contract drafted with OpenAPI types.',
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const out = renderCodexDemoSession(sessionFile, sessionId);
    expect(out).toContain('> Design the checkout session API contract and OpenAPI types.');
    expect(out).toContain('Checkout session contract drafted with OpenAPI types.');
    expect(out).toContain(`Codex session: ${sessionId}`);
    expect(out).not.toContain('Sandbox validation complete');
  });

  it('falls back when the session file is missing', () => {
    const out = renderCodexDemoSession('/tmp/missing-session.jsonl', 'sess-missing');
    expect(out).toContain('no persisted transcript');
    expect(out).toContain('Codex session: sess-missing');
  });
});
