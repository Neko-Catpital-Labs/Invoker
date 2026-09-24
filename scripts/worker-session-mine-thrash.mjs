#!/usr/bin/env node
/**
 * Mechanical thrash detector for Invoker worker Claude JSONL sessions.
 * No LLM. Used by worker-session-mine and follow-up repro tasks.
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(__dirname, 'fixtures', 'session-structural-summary');

export const DEFAULT_THRESHOLDS = Object.freeze({
  minAssistantTurns: 40,
  minCacheReadTokens: 10_000_000,
  minTotalTokens: 10_000_000,
  minSameBashArgv: 5,
});

export function sessionHash(sessionId, workflowName = '') {
  return createHash('sha256').update(`${workflowName}\0${sessionId}`).digest('hex').slice(0, 16);
}

const CWD_WORKTREE_RE = /experiment-wf-\d+-\d+-(.+?)-g\d+\.t\d+\.a-/;
const CWD_MERGE_RE = /merge-clones\//;
const CWD_SCRATCH_RE = /invoker-scratch-/;
const PHASE_MARKER_RE = /^\s*(?:#+\s*)?(?:phase|step|checkpoint)\s*[:#]?\s*(?:\d+|[a-z][\w-]*)/i;
const READONLY_BASH_RE = /^\s*(cat|head|tail|less|ls|pwd|git status|git diff|git log|rg|grep|sed|find)\b/;
const PROOF_BASH_RE = /(pnpm\s+(?:run\s+)?test|npm\s+test|npx\s+vitest|vitest\b|pytest\b|python3?\s+-m\s+unittest|--self-test|self-test)/i;

function taskClassFromCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd) return '';
  const m = CWD_WORKTREE_RE.exec(cwd);
  if (m) return m[1];
  if (CWD_MERGE_RE.test(cwd)) return 'merge-clone';
  if (CWD_SCRATCH_RE.test(cwd)) return 'scratch';
  return '';
}

function commandStatus(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.status === 'completed') return true;
  if (payload.status === 'failed' || payload.status === 'errored') return false;
  return null;
}

function collectTextBlocks(row, msg, payload) {
  const texts = [];
  const visitContent = (content) => {
    if (typeof content === 'string') texts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block?.text === 'string') texts.push(block.text);
      }
    }
  };
  visitContent(msg?.content);
  visitContent(payload?.content);
  if (typeof row.text === 'string') texts.push(row.text);
  return texts;
}

function classifySemanticStructure(summary) {
  const progress = summary.progressSignals;
  const repeatedReloads = summary.contextReloads.repeatedReadPaths.length
    + summary.contextReloads.repeatedReadonlyCommands.length
    + summary.contextReloads.repeatedCommands.length;
  const successfulProof = summary.proofMarkers.some((m) => m.success === true);
  const completed = summary.outcomeMarkers.some((m) => m.kind === 'task_complete' || m.kind === 'result_success');
  const failed = summary.outcomeMarkers.some((m) => m.kind === 'error_event' || m.kind === 'result_error');

  if ((progress.toolUseEdits > 0 || successfulProof || completed) && !failed) {
    return {
      label: 'structural-progress',
      confidence: successfulProof || completed ? 'high' : 'medium',
      signals: {
        edits: progress.toolUseEdits,
        successfulProofs: summary.proofMarkers.filter((m) => m.success === true).length,
        completed,
        repeatedReloads,
      },
    };
  }
  if (progress.toolUseEdits === 0 && !successfulProof && !completed && repeatedReloads > 0) {
    return {
      label: 'repeated-exploration',
      confidence: repeatedReloads >= 2 ? 'high' : 'medium',
      signals: { repeatedReloads, failed },
    };
  }
  return {
    label: 'inconclusive',
    confidence: 'low',
    signals: {
      edits: progress.toolUseEdits,
      proofMarkers: summary.proofMarkers.length,
      completed,
      failed,
      repeatedReloads,
    },
  };
}

export function summarizeSessionStructure(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);

  let taskClass = '';
  const phaseMarkers = [];
  let toolUseEdits = 0;
  let toolResultSuccesses = 0;
  let toolResultFailures = 0;
  let commandExecutionCount = 0;
  let finalResult = null;
  const readPathCounts = new Map();
  const readonlyCmdCounts = new Map();
  const commandCounts = new Map();
  const proofMarkers = [];
  const outcomeMarkers = [];
  const checkpointCandidates = [];
  const pendingBashById = new Map();
  const parseErrors = [];
  let index = -1;

  const recordCommand = (cmd, source, status = null, callId = '') => {
    if (!cmd) return;
    commandExecutionCount += 1;
    commandCounts.set(cmd, (commandCounts.get(cmd) ?? 0) + 1);
    if (READONLY_BASH_RE.test(cmd)) {
      readonlyCmdCounts.set(cmd, (readonlyCmdCounts.get(cmd) ?? 0) + 1);
    }
    if (PROOF_BASH_RE.test(cmd) && source !== 'claude-tool-use') {
      const marker = { command: cmd.slice(0, 200), index, success: status, source };
      proofMarkers.push(marker);
      if (status === true) checkpointCandidates.push({ index, kind: 'proof', detail: marker.command });
    }
    if (callId) pendingBashById.set(callId, cmd);
  };

  for (const line of lines) {
    index += 1;
    let row;
    try {
      row = JSON.parse(line);
    } catch (err) {
      parseErrors.push({ index, error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    const payload = row.payload ?? {};
    if (!taskClass) {
      taskClass = taskClassFromCwd(row.cwd) || taskClassFromCwd(payload.cwd);
    }

    if (row.type === 'event_msg' && typeof payload.type === 'string') {
      if (payload.type === 'task_complete') {
        outcomeMarkers.push({ index, kind: 'task_complete', source: 'codex-event' });
        checkpointCandidates.push({ index, kind: 'task-complete', detail: 'codex-event' });
      } else if (payload.type === 'error') {
        outcomeMarkers.push({ index, kind: 'error_event', source: 'codex-event' });
      }
    }

    if (row.type === 'result' && typeof row.subtype === 'string') {
      finalResult = {
        subtype: row.subtype,
        isError: Boolean(row.is_error),
        numTurns: typeof row.num_turns === 'number' ? row.num_turns : null,
        durationMs: typeof row.duration_ms === 'number' ? row.duration_ms : null,
      };
      outcomeMarkers.push({
        index,
        kind: row.is_error ? 'result_error' : 'result_success',
        source: 'claude-result',
        subtype: row.subtype,
      });
    }

    const msg = row.message ?? row;
    const role = msg.role ?? row.type;
    for (const textBlock of collectTextBlocks(row, msg, payload)) {
      for (const textLine of textBlock.split('\n')) {
        if (PHASE_MARKER_RE.test(textLine)) phaseMarkers.push(textLine.trim().slice(0, 200));
      }
    }

    if (row.type === 'response_item') {
      let codexCmd = '';
      if (payload.type === 'custom_tool_call' && payload.name === 'exec') {
        codexCmd = extractCodexExecCommandFromJsInput(payload.input);
      } else if (payload.type === 'function_call' && payload.name === 'exec_command') {
        codexCmd = extractCodexExecCommandFromArguments(payload.arguments);
      }
      if (codexCmd) recordCommand(codexCmd, 'codex-response-item', commandStatus(payload), payload.call_id ?? payload.id ?? '');
    }

    if (role === 'assistant' || row.type === 'assistant') {
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const block of content) {
        if (block?.type !== 'tool_use') continue;
        if (block.name === 'Edit' || block.name === 'Write') {
          toolUseEdits += 1;
          checkpointCandidates.push({ index, kind: 'edit', detail: String(block.input?.file_path ?? '').slice(0, 200) });
        } else if (block.name === 'Read') {
          const p = String(block.input?.file_path ?? '');
          if (p) readPathCounts.set(p, (readPathCounts.get(p) ?? 0) + 1);
        } else if (block.name === 'Bash' || block.name === 'bash') {
          const cmd = String(block.input?.command ?? block.input?.cmd ?? '').trim();
          recordCommand(cmd, 'claude-tool-use', null, block.id);
        }
      }
    }

    if (role === 'user' || row.type === 'user') {
      const content = msg.content ?? row.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type !== 'tool_result') continue;
          const isError = Boolean(block.is_error);
          if (isError) toolResultFailures += 1; else toolResultSuccesses += 1;
          const cmd = pendingBashById.get(block.tool_use_id);
          if (cmd && PROOF_BASH_RE.test(cmd)) {
            const marker = { command: cmd.slice(0, 200), index, success: !isError };
            proofMarkers.push(marker);
            if (!isError) checkpointCandidates.push({ index, kind: 'proof', detail: marker.command });
          }
          if (cmd) {
            outcomeMarkers.push({
              index,
              kind: isError ? 'tool_result_error' : 'tool_result_success',
              source: 'claude-tool-result',
              command: cmd.slice(0, 200),
            });
          }
        }
      }
    }
  }

  for (const marker of phaseMarkers) {
    checkpointCandidates.push({ index: -1, kind: 'phase-marker', detail: marker });
  }

  const repeatedReadPaths = [];
  for (const [p, c] of readPathCounts) if (c > 1) repeatedReadPaths.push({ path: p, count: c });
  const repeatedReadonlyCommands = [];
  for (const [c, n] of readonlyCmdCounts) if (n > 1) repeatedReadonlyCommands.push({ command: c, count: n });
  const repeatedCommands = [];
  for (const [c, n] of commandCounts) if (n > 1) repeatedCommands.push({ command: c.slice(0, 200), count: n });

  return {
    taskClass: taskClass || 'unknown',
    phaseMarkers: phaseMarkers.slice(0, 20),
    progressSignals: {
      toolUseEdits,
      toolResultSuccesses,
      toolResultFailures,
      commandExecutionCount,
      finalResult,
    },
    evidenceSignals: {
      proofCommandCount: proofMarkers.length,
      successfulProofCount: proofMarkers.filter((m) => m.success === true).length,
      failedProofCount: proofMarkers.filter((m) => m.success === false).length,
      taskCompleteCount: outcomeMarkers.filter((m) => m.kind === 'task_complete').length,
      errorEventCount: outcomeMarkers.filter((m) => m.kind === 'error_event' || m.kind === 'result_error').length,
    },
    contextReloads: {
      repeatedReadPaths: repeatedReadPaths.slice(0, 20),
      repeatedReadonlyCommands: repeatedReadonlyCommands.slice(0, 20),
      repeatedCommands: repeatedCommands.slice(0, 20),
    },
    proofMarkers: proofMarkers.slice(0, 20),
    outcomeMarkers: outcomeMarkers.slice(0, 20),
    checkpointCandidates: checkpointCandidates.slice(0, 20),
    parseErrors: parseErrors.slice(0, 5),
  };
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
  let totalTokens = 0;
  let codexTotalTokens = 0;
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
      totalTokens += (Number(usage.input_tokens ?? 0) || 0) + (Number(usage.output_tokens ?? 0) || 0);
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
      const total = Number(usage.total_tokens ?? 0) || (Number(usage.input_tokens ?? 0) || 0) + (Number(usage.output_tokens ?? 0) || 0);
      if (total > codexTotalTokens) codexTotalTokens = total;
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
      totalTokens += (Number(usage.input_tokens ?? 0) || 0)
        + (Number(usage.output_tokens ?? 0) || 0)
        + (Number(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? 0) || 0)
        + (Number(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? 0) || 0);
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
  totalTokens += codexTotalTokens;

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
  if (totalTokens >= thresholds.minTotalTokens) {
    reasons.push(`total_tokens=${totalTokens}>=${thresholds.minTotalTokens}`);
  }
  if (maxSameBash >= thresholds.minSameBashArgv) {
    reasons.push(`same_bash_argv=${maxSameBash}>=${thresholds.minSameBashArgv}`);
  }

  const structuralSummary = summarizeSessionStructure(text);
  return {
    assistantTurns,
    cacheReadTokens,
    maxSameBash,
    maxSameBashCmd: maxSameBashCmd.slice(0, 200),
    workflowHint,
    totalTokens,
    thrash: reasons.length > 0,
    reasons,
    structuralSummary,
    semanticClassification: classifySemanticStructure(structuralSummary),
  };
}

export function analyzeClaudeJsonlFile(path, thresholds = DEFAULT_THRESHOLDS) {
  if (!existsSync(path)) {
    return {
      thrash: false,
      reasons: [`missing:${path}`],
      assistantTurns: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      maxSameBash: 0,
      structuralSummary: null,
      semanticClassification: null,
    };
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

  const heavyClaude = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Fix CI job required-fast / Vitest Workspace' } }),
    ...Array.from({ length: 12 }, () => JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        usage: { input_tokens: 400_000, output_tokens: 5_000, cache_read_input_tokens: 500_000, cache_creation_input_tokens: 20_000 },
        content: [{ type: 'text', text: 'working' }],
      },
    })),
  ].join('\n');
  const heavy = analyzeClaudeJsonl(heavyClaude);
  if (heavy.totalTokens !== 11_100_000) throw new Error(`expected 11,100,000 total tokens, got ${heavy.totalTokens}`);
  if (!heavy.reasons.some((r) => r.startsWith('total_tokens='))) throw new Error(`expected total_tokens reason, got ${JSON.stringify(heavy.reasons)}`);
  if (heavy.reasons.some((r) => r.startsWith('cache_read_tokens=') || r.startsWith('assistant_turns='))) throw new Error('heavy fixture must trip only on total tokens');

  const heavyCodex = [
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 9_000_000, cached_input_tokens: 8_900_000, output_tokens: 40_000 } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1_500_000, cached_input_tokens: 1_400_000, output_tokens: 10_000 } }),
  ].join('\n');
  const heavyCodexRes = analyzeClaudeJsonl(heavyCodex, { ...DEFAULT_THRESHOLDS, minCacheReadTokens: 50_000_000 });
  if (heavyCodexRes.totalTokens !== 10_550_000) throw new Error(`expected 10,550,000 codex mirror total tokens, got ${heavyCodexRes.totalTokens}`);
  if (!heavyCodexRes.reasons.some((r) => r.startsWith('total_tokens='))) throw new Error('expected codex mirror total_tokens reason');

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
  if (codexJsPos.totalTokens !== 8000) throw new Error(`expected codex total_tokens to take the final cumulative value (8000), got ${codexJsPos.totalTokens}`);
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

  const productive = analyzeClaudeJsonlFile(join(FIXTURES_DIR, 'claude-productive-long.jsonl'));
  const exploration = analyzeClaudeJsonlFile(join(FIXTURES_DIR, 'claude-repeated-exploration.jsonl'));
  const codexProductive = analyzeClaudeJsonlFile(join(FIXTURES_DIR, 'codex-typed-progress.jsonl'));
  const codexExploration = analyzeClaudeJsonlFile(join(FIXTURES_DIR, 'codex-repeated-exploration.jsonl'));
  if (productive.structuralSummary.taskClass !== 'fix-flaky-retry') {
    throw new Error(`expected productive taskClass fix-flaky-retry, got ${productive.structuralSummary.taskClass}`);
  }
  if (productive.structuralSummary.progressSignals.toolUseEdits !== 4) {
    throw new Error(`expected 4 productive edits, got ${productive.structuralSummary.progressSignals.toolUseEdits}`);
  }
  if (productive.structuralSummary.proofMarkers.length !== 1 || !productive.structuralSummary.proofMarkers[0].success) {
    throw new Error(`expected one successful proof marker, got ${JSON.stringify(productive.structuralSummary.proofMarkers)}`);
  }
  if (productive.structuralSummary.phaseMarkers.length !== 3) {
    throw new Error(`expected 3 phase markers, got ${JSON.stringify(productive.structuralSummary.phaseMarkers)}`);
  }
  if (productive.structuralSummary.contextReloads.repeatedReadonlyCommands.length !== 0) {
    throw new Error('productive fixture must have no repeated readonly commands');
  }
  if (exploration.structuralSummary.progressSignals.toolUseEdits !== 0) {
    throw new Error('exploration fixture must have zero edits');
  }
  if (exploration.structuralSummary.proofMarkers.length !== 0) {
    throw new Error('exploration fixture must have zero proof markers');
  }
  const repeated = exploration.structuralSummary.contextReloads.repeatedReadonlyCommands;
  if (repeated.length !== 2 || !repeated.some((r) => r.command === 'git log --oneline -20' && r.count === 5)) {
    throw new Error(`expected repeated readonly commands to include git log x5, got ${JSON.stringify(repeated)}`);
  }
  if (productive.structuralSummary.checkpointCandidates.length <= exploration.structuralSummary.checkpointCandidates.length) {
    throw new Error('expected productive session to surface more checkpoint candidates than repeated exploration');
  }
  if (productive.semanticClassification.label !== 'structural-progress') {
    throw new Error(`expected productive semantic classification structural-progress, got ${JSON.stringify(productive.semanticClassification)}`);
  }
  if (exploration.semanticClassification.label !== 'repeated-exploration') {
    throw new Error(`expected exploration semantic classification repeated-exploration, got ${JSON.stringify(exploration.semanticClassification)}`);
  }
  if (codexProductive.structuralSummary.taskClass !== 'fix-token-bench') {
    throw new Error(`expected codex taskClass fix-token-bench, got ${codexProductive.structuralSummary.taskClass}`);
  }
  if (codexProductive.structuralSummary.evidenceSignals.taskCompleteCount !== 1) {
    throw new Error(`expected codex task_complete evidence, got ${JSON.stringify(codexProductive.structuralSummary.evidenceSignals)}`);
  }
  if (!codexProductive.structuralSummary.proofMarkers.some((m) => m.command === 'pnpm test' && m.success === true)) {
    throw new Error(`expected codex typed proof command, got ${JSON.stringify(codexProductive.structuralSummary.proofMarkers)}`);
  }
  if (codexProductive.semanticClassification.label !== 'structural-progress') {
    throw new Error(`expected codex productive semantic classification structural-progress, got ${JSON.stringify(codexProductive.semanticClassification)}`);
  }
  if (!codexExploration.structuralSummary.contextReloads.repeatedCommands.some((r) => r.command === 'rg -n token scripts' && r.count === 4)) {
    throw new Error(`expected codex repeated command x4, got ${JSON.stringify(codexExploration.structuralSummary.contextReloads)}`);
  }
  if (codexExploration.semanticClassification.label !== 'repeated-exploration') {
    throw new Error(`expected codex exploration semantic classification repeated-exploration, got ${JSON.stringify(codexExploration.semanticClassification)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    positiveReasons: pos.reasons,
    heavyReasons: heavy.reasons,
    heavyCodexReasons: heavyCodexRes.reasons,
    negativeThrash: neg.thrash,
    codexJsReasons: codexJsPos.reasons,
    codexFnCallReasons: codexFnCallPos.reasons,
    codexNegativeThrash: codexNeg.thrash,
    productiveStructuralSummary: productive.structuralSummary,
    explorationStructuralSummary: exploration.structuralSummary,
    codexProductiveStructuralSummary: codexProductive.structuralSummary,
    codexExplorationStructuralSummary: codexExploration.structuralSummary,
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
