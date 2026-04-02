/**
 * CodexSessionDriver — SessionDriver for Codex CLI.
 *
 * Codex exec --json outputs JSONL to stdout. This driver:
 *   - Stores raw JSONL to <INVOKER_DB_DIR>/agent-sessions/<sessionId>.jsonl
 *   - Converts JSONL to human-readable text via toReadableText()
 *   - Loads and parses stored sessions for retrieval
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SessionDriver } from './session-driver.js';
import { parseCodexSessionJsonl, toReadableText, extractCodexSessionId } from './codex-session.js';
import type { AgentMessage } from './codex-session.js';

export class CodexSessionDriver implements SessionDriver {
  private getStorageDir(): string {
    const base = process.env.INVOKER_DB_DIR || join(homedir(), '.invoker');
    return join(base, 'agent-sessions');
  }

  extractSessionId(rawStdout: string): string | undefined {
    return extractCodexSessionId(rawStdout);
  }

  processOutput(sessionId: string, rawStdout: string): string {
    const dir = this.getStorageDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sessionId}.jsonl`), rawStdout);
    return toReadableText(rawStdout);
  }

  loadSession(sessionId: string): string | null {
    const filePath = join(this.getStorageDir(), `${sessionId}.jsonl`);
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, 'utf-8');
  }

  parseSession(raw: string): AgentMessage[] {
    return parseCodexSessionJsonl(raw);
  }
}
