export const EXECUTION_ROUTING_FRAGMENT = `# Invoker execution routing

When Invoker MCP (\`invoker_prepare_plan_review\` / \`invoker_submit_plan\`) or \`invoker-cli\` is available:

- Read-only questions: stay local.
- Stay in this chat when **all** hold: current repo only; one review slice / one layer; feature iteration on existing files or a one-file bug with a local repro.
- Delegate to Invoker when **any** hold: more than one layer, review slice, package boundary, or PR-worthy commit; cross-repo; overnight / user stepping away; agent self-routes mid-task.
- First action on delegate: read \`invoker-chat-submit\` then \`invoker-plan-to-invoker\`. Fill Goal / Motivation / Safety invariant from context. Run the planning completeness gate. \`auto_submit\` only when that gate passes; otherwise AskQuestion / clarify on this surface and do not submit.
- Announce the route in one line so the user can interrupt with “do it locally.”
- Explicit “do it locally” / “don’t use Invoker” in the current message wins.
- Dirty working tree alone does **not** force Invoker.
- About to fan out subagents? Read \`invoker-route-delegation\` first: units that commit, open a PR, tag, merge, or deploy go to Invoker, never a subagent swarm; read-only units may fan out.
- If MCP and CLI are both missing: stay local.

Slash commands \`/invoker-plan-to-invoker\` and \`/plan-to-invoker\` always enter the skill.
Approval authorizes the reviewed plan's declared \`onFinish\` outcome. Implementation plans default to \`onFinish: pull_request\`, so approval includes GitHub branch and PR/stack publication; \`onFinish: none\` publishes nothing. Follow the installed make-pr skill for publication procedure without asking for a second authorization.
After submit, arm \`invoker-cli wait <workflowId>\` with \`notify_on_output\` on \`^INVOKER_WAKE\`, end the turn, and continue the parent job on wake.
`;

export const CURSOR_RULE_CONTENTS = `---
description: One-slice same-repo work stays local; multi-layer work goes through Invoker auto_submit after the completeness gate
alwaysApply: true
---

# Invoker execution routing

When Invoker MCP (\`invoker_prepare_plan_review\` / \`invoker_submit_plan\`) or \`invoker-cli\` is available:

- Read-only questions: stay local.
- Stay in this chat when **all** hold: current repo only; one review slice / one layer; feature iteration on existing files or a one-file bug with a local repro.
- Delegate to Invoker when **any** hold: more than one layer, review slice, package boundary, or PR-worthy commit; cross-repo; overnight / user stepping away; agent self-routes mid-task.
- First action on delegate: read the installed \`invoker-chat-submit\` skill, then \`invoker-plan-to-invoker\` (\`~/.cursor/skills/invoker-plan-to-invoker/SKILL.md\` or \`~/.claude/skills/invoker-plan-to-invoker/SKILL.md\`). Fill Goal / Motivation / Safety invariant from context. Run the planning completeness gate. \`auto_submit\` only when that gate passes; otherwise AskQuestion / clarify on this surface and do not submit.
- Announce the route in one line so the user can interrupt with “do it locally.”
- Explicit “do it locally” / “don’t use Invoker” in the current message wins.
- Dirty working tree alone does **not** force Invoker.
- About to fan out subagents? Read \`invoker-route-delegation\` first: units that commit, open a PR, tag, merge, or deploy go to Invoker, never a subagent swarm; read-only units may fan out.
- If MCP and CLI are both missing: stay local.

Slash commands \`/invoker-plan-to-invoker\` and \`/plan-to-invoker\` always enter the skill.
Approval authorizes the reviewed plan's declared \`onFinish\` outcome. Implementation plans default to \`onFinish: pull_request\`, so approval includes GitHub branch and PR/stack publication; \`onFinish: none\` publishes nothing. Follow the installed make-pr skill for publication procedure without asking for a second authorization.
After submit, arm \`invoker-cli wait <workflowId>\` with \`notify_on_output\` on \`^INVOKER_WAKE\`, end the turn, and continue the parent job on wake.
`;

export const CLAUDE_HOOK_SCRIPT = `#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const additionalContext = ${JSON.stringify(EXECUTION_ROUTING_FRAGMENT.trim())};
const TASK_NOTIFICATION_PREFIX = '<task-notification>';
const STATE_DIR_NAME = 'invoker-execution-hook';
const COMPACTION_MARKERS = ['"compact_boundary"', '"isCompactSummary":true', '"isCompactSummary": true'];
const STATE_DIR_MODE = 0o700;
const STATE_FILE_MODE = 0o600;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function warn(what, error) {
  process.stderr.write(\`invoker-execution hook: \${what}: \${error && error.message ? error.message : String(error)}\\n\`);
}

function readEvent() {
  let raw;
  try {
    raw = readFileSync(0, 'utf8');
  } catch (error) {
    warn('could not read hook stdin', error);
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
    warn('hook stdin was not a JSON object', \`got \${typeof parsed}\`);
    return null;
  } catch (error) {
    warn('could not parse hook stdin as JSON', error);
    return null;
  }
}

function stateFilePath(sessionId) {
  const dir = path.join(tmpdir(), STATE_DIR_NAME);
  mkdirSync(dir, { recursive: true, mode: STATE_DIR_MODE });
  const stat = lstatSync(dir);
  if (!stat.isDirectory()) throw new Error(\`hook state path is not a directory: \${dir}\`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(\`hook state directory is not owned by this user: \${dir}\`);
  }
  if ((stat.mode & 0o077) !== 0) chmodSync(dir, STATE_DIR_MODE);
  return path.join(dir, \`\${createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}.json\`);
}

function readLastInjectedCompactions(file) {
  let raw;
  try {
    const fd = openSync(file, constants.O_RDONLY | NOFOLLOW);
    try {
      raw = readFileSync(fd, 'utf8');
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { known: true, value: null };
    warn(\`could not read hook state \${file}\`, error);
    return { known: false, value: null };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.compactions === 'number') return { known: true, value: parsed.compactions };
    return { known: false, value: null };
  } catch (error) {
    warn(\`could not parse hook state \${file}\`, error);
    return { known: false, value: null };
  }
}

function countCompactions(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return { known: false, value: 0 };
  let raw;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch (error) {
    if (!error || error.code !== 'ENOENT') warn(\`could not read transcript \${transcriptPath}\`, error);
    return { known: false, value: 0 };
  }
  let count = 0;
  for (const line of raw.split('\\n')) {
    if (line && COMPACTION_MARKERS.some((marker) => line.includes(marker))) count += 1;
  }
  return { known: true, value: count };
}

function rememberInjection(file, compactions) {
  let fd;
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW, STATE_FILE_MODE);
  } catch (error) {
    warn(\`could not write hook state \${file}\`, error);
    return;
  }
  try {
    writeFileSync(fd, JSON.stringify({ compactions }));
  } catch (error) {
    warn(\`could not write hook state \${file}\`, error);
  } finally {
    closeSync(fd);
  }
}

function shouldInject(event) {
  const prompt = typeof event.prompt === 'string' ? event.prompt : '';
  if (prompt.trimStart().startsWith(TASK_NOTIFICATION_PREFIX)) return false;
  const sessionId = typeof event.session_id === 'string' ? event.session_id.trim() : '';
  if (!sessionId) return true;

  let file;
  try {
    file = stateFilePath(sessionId);
  } catch (error) {
    warn('could not open hook state directory', error);
    return true;
  }

  const lastInjected = readLastInjectedCompactions(file);
  const compactions = countCompactions(event.transcript_path);
  if (lastInjected.known && lastInjected.value !== null && compactions.known && compactions.value <= lastInjected.value) {
    return false;
  }
  rememberInjection(file, compactions.known ? compactions.value : (lastInjected.value ?? 0));
  return true;
}

function main() {
  if (!additionalContext) {
    warn('no delegation reminder to inject', 'the execution routing fragment is empty');
    return;
  }
  const event = readEvent();
  if (!event) return;
  if (!shouldInject(event)) return;
  process.stdout.write(\`\${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  })}\\n\`);
}

main();
`;
