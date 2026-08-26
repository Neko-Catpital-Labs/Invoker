#!/usr/bin/env node
/**
 * Mechanical thrash detector for Invoker worker Claude JSONL sessions.
 * No LLM. Used by worker-session-mine and follow-up repro tasks.
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export const DEFAULT_THRESHOLDS = Object.freeze({
  minAssistantTurns: 40,
  minCacheReadTokens: 10_000_000,
  minSameBashArgv: 5,
});

export function sessionHash(sessionId, workflowName = '') {
  return createHash('sha256').update(`${workflowName}\0${sessionId}`).digest('hex').slice(0, 16);
}

export function analyzeClaudeJsonl(text, thresholds = DEFAULT_THRESHOLDS) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  let assistantTurns = 0;
  let cacheReadTokens = 0;
  const bashCounts = new Map();
  let workflowHint = '';

  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    // Codex structured stream
    if (row.type === 'turn.completed' || row.type === 'turn.failed') {
      assistantTurns += 1;
      const usage = row.usage ?? {};
      cacheReadTokens += Number(usage.cache_read_input_tokens ?? usage.input_tokens ?? 0) || 0;
      continue;
    }
    if (row.type === 'item.completed' && row.item?.type === 'command_execution') {
      const cmd = String(row.item?.command ?? row.item?.cmd ?? '').trim();
      if (cmd) bashCounts.set(cmd, (bashCounts.get(cmd) ?? 0) + 1);
    }
    const msg = row.message ?? row;
    const role = msg.role ?? row.type;
    if (role === 'assistant' || row.type === 'assistant') {
      assistantTurns += 1;
      const usage = msg.usage ?? row.usage ?? {};
      cacheReadTokens += Number(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? 0) || 0;
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const block of content) {
        if (block?.type === 'tool_use' && (block.name === 'Bash' || block.name === 'bash')) {
          const cmd = String(block.input?.command ?? block.input?.cmd ?? '').trim();
          if (cmd) bashCounts.set(cmd, (bashCounts.get(cmd) ?? 0) + 1);
        }
      }
    }
    if (!workflowHint && (role === 'user' || row.type === 'user')) {
      const textParts = [];
      const content = msg.content ?? row.content;
      if (typeof content === 'string') textParts.push(content);
      else if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block?.text === 'string') textParts.push(block.text);
        }
      }
      const joined = textParts.join('\n');
      const m = joined.match(/admin-bypass-[a-z0-9-]+/i);
      if (m) workflowHint = m[0];
      else if (/Failed check:/i.test(joined)) workflowHint = 'admin-bypass-repair';
    }
  }

  let maxSameBash = 0;
  let maxSameBashCmd = '';
  for (const [cmd, count] of bashCounts) {
    if (count > maxSameBash) {
      maxSameBash = count;
      maxSameBashCmd = cmd;
    }
  }

  const reasons = [];
  if (assistantTurns >= thresholds.minAssistantTurns) {
    reasons.push(`assistant_turns=${assistantTurns}>=${thresholds.minAssistantTurns}`);
  }
  if (cacheReadTokens >= thresholds.minCacheReadTokens) {
    reasons.push(`cache_read_tokens=${cacheReadTokens}>=${thresholds.minCacheReadTokens}`);
  }
  if (maxSameBash >= thresholds.minSameBashArgv) {
    reasons.push(`same_bash_argv=${maxSameBash}>=${thresholds.minSameBashArgv}`);
  }

  return {
    assistantTurns,
    cacheReadTokens,
    maxSameBash,
    maxSameBashCmd: maxSameBashCmd.slice(0, 200),
    workflowHint,
    thrash: reasons.length > 0,
    reasons,
  };
}

export function analyzeClaudeJsonlFile(path, thresholds = DEFAULT_THRESHOLDS) {
  if (!existsSync(path)) {
    return { thrash: false, reasons: [`missing:${path}`], assistantTurns: 0, cacheReadTokens: 0, maxSameBash: 0 };
  }
  return analyzeClaudeJsonl(readFileSync(path, 'utf8'), thresholds);
}

export function runTokenAuditIfAvailable(jsonlPath, catstackRoot = process.env.CATSTACK_ROOT) {
  if (!catstackRoot) return null;
  const script = `${catstackRoot.replace(/\/$/, '')}/engine/skills/reflect/scripts/token_audit.py`;
  if (!existsSync(script)) {
    const alt = `${catstackRoot.replace(/\/$/, '')}/skills/reflect/scripts/token_audit.py`;
    if (!existsSync(alt)) return null;
    return runTokenAuditScript(alt, jsonlPath);
  }
  return runTokenAuditScript(script, jsonlPath);
}

function runTokenAuditScript(script, jsonlPath) {
  const result = spawnSync('python3', [script, 'claude', jsonlPath, '--out', '-'], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) {
    return { ok: false, error: result.stderr || result.stdout || `exit ${result.status}` };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    const flags = parsed.flags ?? parsed.thrash_flags ?? parsed;
    const interesting = [
      'recurring-failure-signatures',
      'no-verify-edit-streak',
      'cache-creation-spikes',
    ].filter((k) => {
      const v = flags?.[k] ?? flags?.[k.replace(/-/g, '_')];
      return Array.isArray(v) ? v.length > 0 : Boolean(v);
    });
    return { ok: true, flags: interesting, raw: parsed };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function detectThrash(jsonlPath, options = {}) {
  const mechanical = analyzeClaudeJsonlFile(jsonlPath, options.thresholds ?? DEFAULT_THRESHOLDS);
  const audit = runTokenAuditIfAvailable(jsonlPath, options.catstackRoot);
  const reasons = [...mechanical.reasons];
  if (audit?.ok && audit.flags?.length) {
    for (const flag of audit.flags) reasons.push(`token_audit:${flag}`);
  }
  return {
    ...mechanical,
    thrash: reasons.length > 0,
    reasons,
    tokenAudit: audit,
  };
}

function selfTest() {
  const thrashy = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Failed check: PR Body\nadmin-bypass-repair-check-pr-1' } }),
    ...Array.from({ length: 40 }, (_, i) => JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        usage: { cache_read_input_tokens: 300_000 },
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'python3 scripts/foo.py' } }],
      },
    })),
  ].join('\n');
  const clean = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', usage: { cache_read_input_tokens: 100 }, content: [{ type: 'text', text: 'ok' }] } }),
  ].join('\n');
  const pos = analyzeClaudeJsonl(thrashy);
  const neg = analyzeClaudeJsonl(clean);
  if (!pos.thrash) throw new Error('expected thrash fixture to fire');
  if (neg.thrash) throw new Error('expected clean fixture to stay silent');
  const codexThrashy = Array.from({ length: 40 }, () => JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } })).join('\n');
  const codexPos = analyzeClaudeJsonl(codexThrashy);
  if (!codexPos.thrash) throw new Error('expected codex turn.completed thrash');
  console.log(JSON.stringify({ ok: true, positiveReasons: pos.reasons, negativeThrash: neg.thrash, codexReasons: codexPos.reasons }, null, 2));
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('worker-session-mine-thrash.mjs');
if (process.argv.includes('--self-test')) {
  selfTest();
} else if (isMain && process.argv[2] && process.argv[2] !== '--self-test') {
  const report = detectThrash(process.argv[2]);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.thrash ? 0 : 1);
}
