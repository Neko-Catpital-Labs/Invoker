#!/usr/bin/env node
/**
 * Self-test for multi-harness transcript path resolution.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTranscriptPath } from './worker-session-mine-resolve.mjs';

const root = mkdtempSync(join(tmpdir(), 'session-mine-resolve-'));
try {
  process.env.INVOKER_CLAUDE_CONFIG_DIR = join(root, 'claude-worker');
  process.env.CLAUDE_CONFIG_DIR = process.env.INVOKER_CLAUDE_CONFIG_DIR;
  process.env.INVOKER_DB_DIR = root;

  const claudeProjects = join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'enc-cwd');
  mkdirSync(claudeProjects, { recursive: true });
  writeFileSync(join(claudeProjects, 'sid-claude.jsonl'), '{}\n');

  const sessions = join(root, 'agent-sessions');
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, 'sid-codex.jsonl'), '{}\n');
  writeFileSync(join(sessions, 'sid-omp.omp.txt'), 'hi\n');

  const claudePath = resolveTranscriptPath('claude', 'sid-claude');
  const codexPath = resolveTranscriptPath('codex', 'sid-codex');
  const ompPath = resolveTranscriptPath('omp', 'sid-omp');
  const missing = resolveTranscriptPath('kimi', 'sid-x');

  if (!claudePath?.includes('claude-worker')) throw new Error(`claude path wrong: ${claudePath}`);
  if (!codexPath?.endsWith('sid-codex.jsonl')) throw new Error(`codex path wrong: ${codexPath}`);
  if (!ompPath?.endsWith('sid-omp.omp.txt')) throw new Error(`omp path wrong: ${ompPath}`);
  if (missing !== null) throw new Error('kimi should be null');
  console.log(JSON.stringify({ ok: true, claudePath, codexPath, ompPath }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
  delete process.env.INVOKER_CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.INVOKER_DB_DIR;
}
