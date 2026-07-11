#!/usr/bin/env node
/**
 * Render a persisted Codex agent-sessions/<id>.jsonl transcript for the e2e
 * `codex resume` stub (INVOKER_E2E_CODEX_DEMO=1).
 *
 * Usage: node render-codex-demo-session.mjs <session.jsonl> <sessionId>
 */
import { readFileSync, existsSync } from 'node:fs';

export function renderCodexDemoSession(sessionFile, sessionId) {
  if (!sessionFile || !existsSync(sessionFile)) {
    return [
      `› Resumed Codex session ${sessionId || ''} (no persisted transcript).`,
      '',
      `Codex session: ${sessionId || ''}`,
    ].join('\n');
  }

  const lines = [];
  const raw = readFileSync(sessionFile, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const item = event?.item;
    if (event?.type === 'item.completed' && item?.text) {
      if (item.type === 'user_message') lines.push(`> ${item.text}`);
      else if (item.type === 'agent_message') lines.push(item.text);
    }
  }
  lines.push('');
  lines.push(`Codex session: ${sessionId || ''}`);
  return lines.join('\n');
}

const isMain = process.argv[1] && (
  process.argv[1].endsWith('render-codex-demo-session.mjs')
  || process.argv[1].endsWith('render-codex-demo-session.js')
);

if (isMain) {
  const [sessionFile, sessionId] = process.argv.slice(2);
  process.stdout.write(`${renderCodexDemoSession(sessionFile, sessionId)}\n`);
}
