import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentMessage } from './codex-session.js';
import type { AgentSessionInspection, SessionDriver } from './session-driver.js';

export class OmpSessionDriver implements SessionDriver {
  processOutput(sessionId: string, rawStdout: string): string {
    const dir = this.getStorageDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sessionId}.omp.txt`), rawStdout);
    return rawStdout;
  }

  loadSession(sessionId: string): string | null {
    const filePath = join(this.getStorageDir(), `${sessionId}.omp.txt`);
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, 'utf-8');
  }

  parseSession(raw: string): AgentMessage[] {
    return raw.length > 0 ? [{ role: 'assistant', content: raw, timestamp: '' }] : [];
  }

  inspectSession(raw: string): AgentSessionInspection {
    return raw.length > 0
      ? { state: 'finished' }
      : { state: 'error', reason: 'Empty OMP session output' };
  }

  private getStorageDir(): string {
    const base = process.env.INVOKER_DB_DIR || join(homedir(), '.invoker');
    return join(base, 'agent-sessions');
  }
}
