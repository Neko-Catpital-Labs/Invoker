/**
 * Resolve on-disk transcript paths for Invoker agent sessions (multi-harness).
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function claudeProjectRoots() {
  const roots = [];
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim()
    || process.env.INVOKER_CLAUDE_CONFIG_DIR?.trim()
    || join(homedir(), '.invoker', 'claude-worker');
  roots.push(join(configDir, 'projects'));
  const legacy = join(homedir(), '.claude', 'projects');
  if (legacy !== roots[0]) roots.push(legacy);
  return roots;
}

export function agentSessionsDir() {
  const base = process.env.INVOKER_DB_DIR || join(homedir(), '.invoker');
  return join(base, 'agent-sessions');
}

function findInClaudeProjects(sessionId, roots = claudeProjectRoots()) {
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let dirs;
    try {
      dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const d of dirs) {
      const candidate = join(root, d.name, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * @param {string} agentName
 * @param {string} sessionId
 * @returns {string | null}
 */
export function resolveTranscriptPath(agentName, sessionId) {
  if (!sessionId) return null;
  const name = (agentName || 'claude').trim().toLowerCase();
  if (name === 'claude') {
    return findInClaudeProjects(sessionId);
  }
  if (name === 'codex') {
    const p = join(agentSessionsDir(), `${sessionId}.jsonl`);
    return existsSync(p) ? p : null;
  }
  if (name === 'omp') {
    const p = join(agentSessionsDir(), `${sessionId}.omp.txt`);
    return existsSync(p) ? p : null;
  }
  // kimi / qwen / cursor: no SessionDriver storage yet
  return null;
}

export function resolveTranscriptPathSelfTest() {
  return {
    claudeRoots: claudeProjectRoots(),
    agentSessionsDir: agentSessionsDir(),
  };
}
