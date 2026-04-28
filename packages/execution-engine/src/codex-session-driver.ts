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
import { spawn } from 'node:child_process';
import type { AgentSessionInspection, SessionDriver, RemoteTarget } from './session-driver.js';
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

  inspectSession(raw: string): AgentSessionInspection {
    let parsedAny = false;
    let sawStarted = false;
    let sawInProgress = false;
    let sawFinished = false;

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        parsedAny = true;
        if (entry.type === 'thread.started' || entry.type === 'turn.started') {
          sawStarted = true;
        }
        if (entry.type === 'thread.completed' || entry.type === 'turn.completed' || entry.type === 'task_complete') {
          sawFinished = true;
        }
        const item = entry.item;
        if (entry.type === 'item.started' || item?.status === 'in_progress') {
          sawInProgress = true;
        }
      } catch {
        // Skip malformed lines; final state falls back to error if nothing parsed.
      }
    }

    if (!parsedAny) {
      return { state: 'error', reason: 'Malformed Codex session JSONL' };
    }
    if (sawFinished) {
      return { state: 'finished' };
    }
    if (sawInProgress || sawStarted) {
      return { state: 'running' };
    }
    return { state: 'error', reason: 'Codex session did not contain recognizable lifecycle markers' };
  }

  /**
   * Fetch a Codex session from a remote SSH host.
   * Reads ~/.invoker/agent-sessions/<sessionId>.jsonl on the remote.
   */
  fetchRemoteSession(sessionId: string, target: RemoteTarget): Promise<string | null> {
    return new Promise((resolve) => {
      const script = `cat ~/.invoker/agent-sessions/${sessionId}.jsonl 2>/dev/null`;
      const sshArgs = [
        '-i', target.sshKeyPath,
        '-p', String(target.port ?? 22),
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'BatchMode=yes',
        `${target.user}@${target.host}`,
        script,
      ];
      const child = spawn('ssh', sshArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.on('close', (code: number | null) => {
        resolve(code === 0 && stdout.trim() ? stdout : null);
      });
      child.on('error', () => resolve(null));
    });
  }
}
