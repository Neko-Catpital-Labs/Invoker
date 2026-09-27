import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AgentLoginAgent } from './slack-agent-login.js';

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const padded = parts[1] + '='.repeat((4 - (parts[1].length % 4)) % 4);
    const json = Buffer.from(padded, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function readClaudeEmail(homeDir: string): string | undefined {
  for (const relative of ['.claude.json', join('.invoker', 'claude-worker', '.claude.json')]) {
    const path = join(homeDir, relative);
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { oauthAccount?: { emailAddress?: unknown } };
      const email = raw.oauthAccount?.emailAddress;
      if (typeof email === 'string' && email.includes('@')) return email.trim();
    } catch {
    }
  }
  return undefined;
}

function readCodexEmail(homeDir: string): string | undefined {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homeDir, '.codex');
  const path = process.env.INVOKER_CODEX_AUTH_PATH?.trim() || join(codexHome, 'auth.json');
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      tokens?: { id_token?: unknown };
    };
    const idToken = raw.tokens?.id_token;
    if (typeof idToken !== 'string') return undefined;
    const claims = decodeJwtPayload(idToken);
    const email = claims?.email;
    if (typeof email === 'string' && email.includes('@')) return email.trim();
  } catch {
    return undefined;
  }
  return undefined;
}

export function readAgentAccountEmail(
  agent: AgentLoginAgent,
  homeDir: string = homedir(),
): string | undefined {
  return agent === 'claude' ? readClaudeEmail(homeDir) : readCodexEmail(homeDir);
}
