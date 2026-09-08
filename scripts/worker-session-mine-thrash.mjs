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

function extractCodexExecCommandFromJsInput(input) {
  if (typeof input !== 'string') return '';
  const match = /cmd\s*:\s*"((?:\\.|[^"\\])*)"/.exec(input);
  if (!match) return '';
  try {
    return String(JSON.parse(`"${match[1]}"`)).trim();
  } catch {
    return '';
  }
}

function extractCodexExecCommandFromArguments(args) {
  if (typeof args !== 'string') return '';
  try {
    const parsed = JSON.parse(args);
    return String(parsed?.cmd ?? parsed?.command ?? '').trim();
  } catch {
    return '';
  }
}

export function analyzeClaudeJsonl(text, thresholds = DEFAULT_THRESHOLDS) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  let assistantTurns = 0;
  let cacheReadTokens = 0;
  let codexCacheReadTokens = 0;
  const bashCounts = new Map();
  let workflowHint = '';

  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    let countedByFormat = false;

    // Legacy Codex stream
    if (row.type === 'turn.completed' || row.type === 'turn.failed') {
      assistantTurns += 1;
      const usage = row.usage ?? {};
      cacheReadTokens += Number(usage.cache_read_input_tokens ?? usage.input_tokens ?? usage.cached_tokens ?? 0) || 0;
      countedByFormat = true;
    }
    if (row.type === 'item.completed' && row.item?.type === 'command_execution') {
      const cmd = String(row.item?.command ?? row.item?.cmd ?? '').trim();
      if (cmd) bashCounts.set(cmd, (bashCounts.get(cmd) ?? 0) + 1);
      countedByFormat = true;
    }

    // Current Codex stream
    if (row.type === 'event_msg' && row.payload?.type === 'token_count') {
      assistantTurns += 1;
      const usage = row.payload?.info?.total_token_usage ?? {};
      const cached = Number(usage.cached_input_tokens ?? 0) || 0;
      if (cached > codexCacheReadTokens) codexCacheReadTokens = cached;
      countedByFormat = true;
    }
    if (row.type === 'response_item') {
      const payload = row.payload ?? {};
      let codexCmd = '';
      if (payload.type === 'custom_tool_call' && payload.name === 'exec') {
        codexCmd = extractCodexExecCommandFromJsInput(payload.input);
      } else if (payload.type === 'function_call' && payload.name === 'exec_command') {
        codexCmd = extractCodexExecCommandFromArguments(payload.arguments);
      }
      if (codexCmd) bashCounts.set(codexCmd, (bashCounts.get(codexCmd) ?? 0) + 1);
      countedByFormat = true;
    }
    const msg = row.message ?? row;
    const role = msg.role ?? row.type;
    if (!countedByFormat && (role === 'assistant' || row.type === 'assistant')) {
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

  cacheReadTokens += codexCacheReadTokens;

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

  const codexTokenCountRow = (cachedInputTokens) => JSON.stringify({
    timestamp: '2026-09-01T00:00:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: cachedInputTokens * 2, cached_input_tokens: cachedInputTokens },
        last_token_usage: { input_tokens: cachedInputTokens, cached_input_tokens: cachedInputTokens },
      },
    },
  });
  const codexExecRow = (cmd) => JSON.stringify({
    timestamp: '2026-09-01T00:00:00.000Z',
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      status: 'completed',
      call_id: 'call_x',
      name: 'exec',
      input: `const r = await tools.exec_command({cmd:"${cmd}","workdir":"/repo","yield_time_ms":10000,"max_output_tokens":20000});\ntext(r.output);`,
    },
  });
  const codexFunctionCallExecRow = (cmd) => JSON.stringify({
    timestamp: '2026-07-03T00:00:00.000Z',
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'exec_command',
      arguments: JSON.stringify({ cmd, workdir: '/repo', yield_time_ms: 10_000, max_output_tokens: 20_000 }),
      call_id: 'call_y',
    },
  });

  const codexTurnsRows = Array.from({ length: 40 }, (_, i) => codexTokenCountRow(100 * (i + 1)));
  const codexRepeatedExecRows = Array.from({ length: 5 }, () => codexExecRow('pnpm test'));
  const codexJsThrashy = [...codexTurnsRows, ...codexRepeatedExecRows].join('\n');
  const codexJsPos = analyzeClaudeJsonl(codexJsThrashy);
  if (!codexJsPos.thrash) throw new Error('expected codex response_item/event_msg thrash to fire');
  if (codexJsPos.assistantTurns !== 40) throw new Error(`expected 40 codex assistant turns, got ${codexJsPos.assistantTurns}`);
  if (codexJsPos.cacheReadTokens !== 4000) throw new Error(`expected codex cache_read_tokens to take the final cumulative value (4000), got ${codexJsPos.cacheReadTokens}`);
  if (codexJsPos.maxSameBash !== 5) throw new Error(`expected 5 repeated codex exec commands, got ${codexJsPos.maxSameBash}`);

  const codexFnCallThrashy = [
    codexTokenCountRow(100),
    codexTokenCountRow(200),
    ...Array.from({ length: 5 }, () => codexFunctionCallExecRow('rg -n foo .')),
  ].join('\n');
  const codexFnCallPos = analyzeClaudeJsonl(codexFnCallThrashy);
  if (!codexFnCallPos.thrash) throw new Error('expected codex function_call/exec_command thrash to fire');
  if (codexFnCallPos.maxSameBash !== 5) throw new Error(`expected 5 repeated codex exec_command commands, got ${codexFnCallPos.maxSameBash}`);

  const codexClean = [
    codexTokenCountRow(100),
    codexTokenCountRow(200),
    codexTokenCountRow(300),
    codexExecRow('git status'),
    codexExecRow('pnpm build'),
  ].join('\n');
  const codexNeg = analyzeClaudeJsonl(codexClean);
  if (codexNeg.thrash) throw new Error('expected clean codex fixture to stay silent');

  console.log(JSON.stringify({
    ok: true,
    positiveReasons: pos.reasons,
    negativeThrash: neg.thrash,
    codexJsReasons: codexJsPos.reasons,
    codexFnCallReasons: codexFnCallPos.reasons,
    codexNegativeThrash: codexNeg.thrash,
  }, null, 2));
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('worker-session-mine-thrash.mjs');
if (process.argv.includes('--self-test')) {
  selfTest();
} else if (isMain && process.argv[2] && process.argv[2] !== '--self-test') {
  const report = detectThrash(process.argv[2]);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.thrash ? 0 : 1);
}
