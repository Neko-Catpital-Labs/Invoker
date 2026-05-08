/**
 * ClaudeSessionDriver — SessionDriver for Claude Code CLI.
 *
 * Claude CLI writes its own session files to ~/.claude/projects/<dir>/<sessionId>.jsonl.
 * This driver:
 *   - processOutput: no-op (Claude manages its own session files)
 *   - loadSession: searches ~/.claude/projects/ for the session file
 *   - parseSession: parses Claude session JSONL format
 *   - fetchRemoteSession: SSH find on remote ~/.claude/projects/
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import type { AgentSessionInspection, SessionDriver, SessionUsageEvent, RemoteTarget } from './session-driver.js';
import type { AgentMessage } from './codex-session.js';

export class ClaudeSessionDriver implements SessionDriver {
  /**
   * No-op. Claude CLI writes its own session file; we don't store it.
   * Returns the raw stdout as-is for display.
   */
  processOutput(_sessionId: string, rawStdout: string): string {
    return rawStdout;
  }

  /**
   * Search ~/.claude/projects/<dir>/<sessionId>.jsonl.
   */
  loadSession(sessionId: string): string | null {
    const claudeProjectsDir = join(homedir(), '.claude', 'projects');
    if (!existsSync(claudeProjectsDir)) return null;

    const projectDirs = readdirSync(claudeProjectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const dir of projectDirs) {
      const candidate = join(claudeProjectsDir, dir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) {
        return readFileSync(candidate, 'utf-8');
      }
    }
    return null;
  }

  /**
   * Parse Claude session JSONL into messages.
   * Format: entry.type === 'user' / 'assistant' with entry.message.content.
   */
  parseSession(raw: string): AgentMessage[] {
    const messages: AgentMessage[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'user' && entry.message?.content) {
          const content = typeof entry.message.content === 'string'
            ? entry.message.content
            : JSON.stringify(entry.message.content);
          messages.push({ role: 'user', content, timestamp: entry.timestamp ?? '' });
        } else if (entry.type === 'assistant' && entry.message?.content) {
          const blocks = Array.isArray(entry.message.content)
            ? entry.message.content
            : [entry.message.content];
          const text = blocks
            .filter((b: any) => typeof b === 'string' || b?.type === 'text')
            .map((b: any) => typeof b === 'string' ? b : b.text ?? '')
            .join('\n');
          if (text) {
            messages.push({ role: 'assistant', content: text, timestamp: entry.timestamp ?? '' });
          }
        }
      } catch {
        // Skip malformed lines
      }
    }
    return messages;
  }

  inspectSession(raw: string): AgentSessionInspection {
    let lastEntry: any | undefined;
    let parsedAny = false;

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        lastEntry = JSON.parse(line);
        parsedAny = true;
      } catch {
        // Ignore malformed lines; only fail if nothing parses.
      }
    }

    if (!parsedAny || !lastEntry) {
      return { state: 'error', reason: 'Malformed Claude session JSONL' };
    }

    if (lastEntry.type === 'user' || lastEntry.type === 'queue-operation') {
      return { state: 'running' };
    }

    if (lastEntry.type === 'assistant') {
      const content = lastEntry.message?.content;
      const blocks = Array.isArray(content) ? content : [content];
      const hasToolUse = blocks.some((block: any) => block?.type === 'tool_use');
      const hasText = blocks.some((block: any) =>
        typeof block === 'string' || block?.type === 'text' || typeof block?.text === 'string');
      if (hasToolUse) return { state: 'running' };
      if (hasText) return { state: 'finished' };
    }

    return { state: 'error', reason: 'Claude session ended in an unrecognized state' };
  }

  /**
   * Extract usage events from Claude session JSONL.
   *
   * Claude CLI assistant entries may carry a top-level `usage` object with
   * input_tokens / output_tokens / cache_read_input_tokens. When usage
   * metadata is absent the entry is skipped (callers may synthesize an
   * unknown-confidence placeholder upstream).
   */
  extractUsage(raw: string): SessionUsageEvent[] {
    const events: SessionUsageEvent[] = [];
    let lineIndex = 0;

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      lineIndex++;
      try {
        const entry = JSON.parse(line);

        // Claude JSONL assistant entries may include usage metadata
        if (entry.type === 'assistant' && entry.usage) {
          const u = entry.usage;
          const input = typeof u.input_tokens === 'number' ? u.input_tokens : 0;
          const output = typeof u.output_tokens === 'number' ? u.output_tokens : 0;
          const cached = typeof u.cache_read_input_tokens === 'number'
            ? u.cache_read_input_tokens
            : 0;
          events.push({
            eventId: `claude-assistant-${lineIndex}`,
            timestamp: entry.timestamp ?? '',
            model: typeof entry.model === 'string' ? entry.model : '',
            inputTokens: input,
            outputTokens: output,
            cachedTokens: cached,
            totalTokens: input + output,
            confidence: 'exact',
          });
        }
      } catch {
        // Skip malformed lines
      }
    }
    return events;
  }

  /**
   * Fetch a Claude session from a remote SSH host.
   * Searches ~/.claude/projects/ on the remote for <sessionId>.jsonl.
   */
  fetchRemoteSession(sessionId: string, target: RemoteTarget): Promise<string | null> {
    return new Promise((resolve) => {
      const script = `find ~/.claude/projects -name '${sessionId}.jsonl' -print -quit 2>/dev/null | head -1 | xargs cat 2>/dev/null`;
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
