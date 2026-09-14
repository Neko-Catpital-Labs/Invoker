#!/usr/bin/env node
/**
 * Mechanical "discovery tax" scorer for agentic Claude/Codex JSONL transcripts.
 * No LLM. Answers: did the agent explore (Grep/Glob/Read, Bash rg/find, or
 * class-search the prompt) before its first edit, and did that correlate
 * with a successful outcome? Repo-owned so CI/fleet mining doesn't need to
 * SSH into transcript hosts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
export const FIXTURES_DIR = join(__dirname, 'fixtures', 'agentic-context-score');

const CLAUDE_EXPLORE_TOOLS = new Set(['Grep', 'Glob', 'Read']);
const CLAUDE_EDIT_TOOLS = new Set(['Edit', 'Write']);
const BASH_EXPLORE_RE = /(^|[\s;&|])(rg|find)\b/;
const CODEX_EXPLORE_CMD_RE = /^\s*(cat|sed|less|head|tail|ls|rg|grep|find)\b/;
const CLASS_SEARCH_RE = /class[- ]search|git log --grep|git log --all\b.*-S\b|git log -S|gh pr list --search/i;

/**
 * Score a single JSONL transcript (Claude tool_use rows or Codex
 * item.completed/turn.completed rows) for discovery-tax signals.
 */
export function scoreSession(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);

  let toolsBeforeFirstEdit = 0;
  let firstEditIndex = -1;
  let toolCallIndex = 0;
  let classSearchInPrompt = false;
  let sawFirstUserPrompt = false;
  let taskStatus = null;
  let agent = 'unknown';

  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = row.message ?? row;
    const role = msg.role ?? row.type;

    if (!sawFirstUserPrompt && (role === 'user' || row.type === 'user')) {
      sawFirstUserPrompt = true;
      const content = msg.content ?? row.content;
      const textParts = [];
      if (typeof content === 'string') textParts.push(content);
      else if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block?.text === 'string') textParts.push(block.text);
        }
      }
      classSearchInPrompt = CLASS_SEARCH_RE.test(textParts.join('\n'));
    }

    if (row.type === 'result' && typeof row.subtype === 'string') {
      taskStatus = row.subtype === 'success' ? 'success' : 'failure';
    } else if ((row.type === 'task_status' || row.type === 'turn.completed') && row.status) {
      taskStatus = row.status === 'success' ? 'success' : 'failure';
    }

    if (role === 'assistant' || row.type === 'assistant') {
      agent = 'claude';
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const block of content) {
        if (block?.type !== 'tool_use') continue;
        if (firstEditIndex !== -1) break;
        const name = block.name;
        if (CLAUDE_EDIT_TOOLS.has(name)) {
          firstEditIndex = toolCallIndex;
          break;
        }
        toolCallIndex += 1;
        if (CLAUDE_EXPLORE_TOOLS.has(name)) {
          toolsBeforeFirstEdit += 1;
        } else if (name === 'Bash' || name === 'bash') {
          const cmd = String(block.input?.command ?? block.input?.cmd ?? '');
          if (BASH_EXPLORE_RE.test(cmd)) toolsBeforeFirstEdit += 1;
        }
      }
      continue;
    }

    if (row.type === 'item.completed') {
      agent = 'codex';
      const item = row.item ?? {};
      if (firstEditIndex !== -1) continue;
      if (item.type === 'file_change') {
        firstEditIndex = toolCallIndex;
        continue;
      }
      toolCallIndex += 1;
      if (item.type === 'command_execution') {
        const cmd = String(item.command ?? item.cmd ?? '');
        if (CODEX_EXPLORE_CMD_RE.test(cmd)) toolsBeforeFirstEdit += 1;
      }
    }
  }

  const discoveryTax = toolsBeforeFirstEdit === 0 && !classSearchInPrompt;
  const terminalFailure = taskStatus === 'success' ? false : discoveryTax && taskStatus === 'failure';

  return {
    agent,
    toolsBeforeFirstEdit,
    firstEditIndex,
    classSearchInPrompt,
    taskStatus,
    discoveryTax,
    terminalFailure,
  };
}

export function scoreSessionFile(path) {
  if (!existsSync(path)) {
    throw new Error(`fixture missing: ${path}`);
  }
  return scoreSession(readFileSync(path, 'utf8'));
}

function claudeRow(toolUseBlocks) {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: toolUseBlocks },
  });
}

function selfTest() {
  const failures = [];
  const check = (label, cond) => {
    if (!cond) failures.push(label);
  };

  // Claude: explores (Grep, Read) before Edit, prompt has class-search language, task succeeds.
  const claudeExploreSuccess = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Fix the bug. Run git log --grep for prior fixes first (class-search).' } }),
    claudeRow([{ type: 'tool_use', name: 'Grep', input: { pattern: 'foo' } }]),
    claudeRow([{ type: 'tool_use', name: 'Read', input: { file_path: '/a.js' } }]),
    claudeRow([{ type: 'tool_use', name: 'Edit', input: { file_path: '/a.js' } }]),
    JSON.stringify({ type: 'result', subtype: 'success' }),
  ].join('\n');
  const exploreSuccess = scoreSession(claudeExploreSuccess);
  check('claude explore+success: agent=claude', exploreSuccess.agent === 'claude');
  check('claude explore+success: toolsBeforeFirstEdit=2', exploreSuccess.toolsBeforeFirstEdit === 2);
  check('claude explore+success: classSearchInPrompt', exploreSuccess.classSearchInPrompt === true);
  check('claude explore+success: taskStatus=success', exploreSuccess.taskStatus === 'success');
  check('claude explore+success: not terminalFailure', exploreSuccess.terminalFailure === false);

  // Claude: edits immediately with no exploration and no class-search prompt, but task still succeeds.
  // Regression guard: success-with-early-grep (and success generally) must never be a terminal failure.
  const claudeOrientedSuccess = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Just change the label text.' } }),
    claudeRow([{ type: 'tool_use', name: 'Edit', input: { file_path: '/a.js' } }]),
    JSON.stringify({ type: 'result', subtype: 'success' }),
  ].join('\n');
  const orientedSuccess = scoreSession(claudeOrientedSuccess);
  check('claude oriented+success: toolsBeforeFirstEdit=0', orientedSuccess.toolsBeforeFirstEdit === 0);
  check('claude oriented+success: discoveryTax true', orientedSuccess.discoveryTax === true);
  check('claude oriented+success: not terminalFailure despite discoveryTax', orientedSuccess.terminalFailure === false);

  // Claude: edits immediately, no exploration, no class-search, and the task fails -> terminal failure.
  const claudeOrientedFailure = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Just change the label text.' } }),
    claudeRow([{ type: 'tool_use', name: 'Edit', input: { file_path: '/a.js' } }]),
    JSON.stringify({ type: 'result', subtype: 'error_generic' }),
  ].join('\n');
  const orientedFailure = scoreSession(claudeOrientedFailure);
  check('claude oriented+failure: taskStatus=failure', orientedFailure.taskStatus === 'failure');
  check('claude oriented+failure: terminalFailure true', orientedFailure.terminalFailure === true);

  // Codex: rg/find before a file_change, task succeeds.
  const codexExploreSuccess = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Fix the bug.' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'rg -n TODO src' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'find . -name "*.ts"' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'file_change', path: 'src/a.ts' } }),
    JSON.stringify({ type: 'turn.completed', status: 'success', usage: { input_tokens: 1 } }),
  ].join('\n');
  const codexExplore = scoreSession(codexExploreSuccess);
  check('codex explore: agent=codex', codexExplore.agent === 'codex');
  check('codex explore: toolsBeforeFirstEdit=2', codexExplore.toolsBeforeFirstEdit === 2);
  check('codex explore: not terminalFailure', codexExplore.terminalFailure === false);

  // Codex: file_change with no prior rg/find and no class-search prompt.
  const codexOriented = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Just change the label text.' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'file_change', path: 'src/a.ts' } }),
    JSON.stringify({ type: 'turn.completed', status: 'success', usage: { input_tokens: 1 } }),
  ].join('\n');
  const codexOrientedScore = scoreSession(codexOriented);
  check('codex oriented: toolsBeforeFirstEdit=0', codexOrientedScore.toolsBeforeFirstEdit === 0);
  check('codex oriented: discoveryTax true', codexOrientedScore.discoveryTax === true);
  check('codex oriented: not terminalFailure (success shields it)', codexOrientedScore.terminalFailure === false);

  if (failures.length) {
    console.error(JSON.stringify({ ok: false, failures }, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({
    ok: true,
    claudeExploreSuccess: exploreSuccess,
    claudeOrientedSuccess: orientedSuccess,
    claudeOrientedFailure: orientedFailure,
    codexExploreSuccess: codexExplore,
    codexOriented: codexOrientedScore,
  }, null, 2));
}

function compareFixtures() {
  const pairs = [
    { agent: 'claude', explore: 'claude-explore-first.jsonl', oriented: 'claude-oriented-edit.jsonl' },
    { agent: 'codex', explore: 'codex-explore-first.jsonl', oriented: 'codex-oriented-edit.jsonl' },
  ];

  const results = {};
  let ok = true;
  for (const pair of pairs) {
    const explore = scoreSessionFile(join(FIXTURES_DIR, pair.explore));
    const oriented = scoreSessionFile(join(FIXTURES_DIR, pair.oriented));
    const pass = explore.toolsBeforeFirstEdit > oriented.toolsBeforeFirstEdit;
    if (!pass) ok = false;
    results[pair.agent] = { explore, oriented, pass };
  }

  console.log(JSON.stringify({ ok, results }, null, 2));
  process.exitCode = ok ? 0 : 1;
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('agentic-context-score.mjs');
if (isMain) {
  if (process.argv.includes('--self-test')) {
    selfTest();
  } else if (process.argv.includes('--compare-fixtures')) {
    compareFixtures();
  } else {
    const target = process.argv[2];
    if (!target) {
      console.error('usage: agentic-context-score.mjs <transcript.jsonl> | --self-test | --compare-fixtures');
      process.exitCode = 1;
    } else {
      const path = existsSync(target) ? target : resolve(REPO_ROOT, target);
      console.log(JSON.stringify(scoreSessionFile(path), null, 2));
    }
  }
}
