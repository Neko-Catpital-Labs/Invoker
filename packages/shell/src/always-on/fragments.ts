export const EXECUTION_ROUTING_FRAGMENT = `# Invoker execution routing

When Invoker MCP (\`invoker_prepare_plan_review\` / \`invoker_submit_plan\`) or \`invoker-cli\` is available:

- Default Invoker owner is **local** (\`invoker-cli mcp\` stdio). Prefer delegating durable work to Invoker over inventing local multi-agent orchestration.
- Read-only questions: stay local.
- Stay in this chat when **all** hold: current repo only; one review slice / one layer; feature iteration on existing files or a one-file bug with a local repro.
- Delegate to Invoker when **any** hold: more than one layer, review slice, package boundary, or PR-worthy commit; cross-repo; overnight / user stepping away; agent self-routes mid-task.
- First action on delegate: read \`invoker-chat-submit\` then \`invoker-plan-to-invoker\`. Fill Goal / Motivation / Safety invariant from context. Run the planning completeness gate. \`auto_submit\` only when that gate passes; otherwise AskQuestion / clarify on this surface and do not submit.
- Announce the route in one line so the user can interrupt with “do it locally.”
- Explicit “do it locally” / “don’t use Invoker” in the current message wins.
- Dirty working tree alone does **not** force Invoker.
- If MCP and CLI are both missing: stay local.

## Local vs remote Invoker (conversational)

- Default: leave harness MCP pointed at local \`invoker-cli mcp\`.
- If the **current turn** names a host, IP, or SSH alias for Invoker (e.g. “use 1.2.3.4”, “on do1”, “ssh my-box”), best-effort retarget before submit:
  1. Probe: \`ssh -o BatchMode=yes -o ConnectTimeout=5 <spec> 'command -v invoker-cli'\` (exit 0 required).
  2. On success only: set the harness \`invoker\` MCP server to \`command: ssh\`, \`args: ["-o","BatchMode=yes","<spec>","invoker-cli","mcp"]\` (Claude/Cursor/OMP JSON or Codex TOML). Do not invent HTTP/SSE MCP.
  3. On probe failure: leave the local MCP entry unchanged and tell the user; do not clobber local.
- “Local” / “this machine” in the current turn restores local \`invoker-cli mcp\`.

Slash commands \`/invoker-plan-to-invoker\` and \`/plan-to-invoker\` always enter the skill.
Plain approval stops after workflow handoff; do not publish PRs unless the user asks.
`;

export const CURSOR_RULE_CONTENTS = `---
description: One-slice same-repo work stays local; multi-layer work goes through Invoker (local MCP by default; host/IP retargets after SSH probe)
alwaysApply: true
---

# Invoker execution routing

When Invoker MCP (\`invoker_prepare_plan_review\` / \`invoker_submit_plan\`) or \`invoker-cli\` is available:

- Default Invoker owner is **local** (\`invoker-cli mcp\` stdio). Prefer delegating durable work to Invoker over inventing local multi-agent orchestration.
- Read-only questions: stay local.
- Stay in this chat when **all** hold: current repo only; one review slice / one layer; feature iteration on existing files or a one-file bug with a local repro.
- Delegate to Invoker when **any** hold: more than one layer, review slice, package boundary, or PR-worthy commit; cross-repo; overnight / user stepping away; agent self-routes mid-task.
- First action on delegate: read the installed \`invoker-chat-submit\` skill, then \`invoker-plan-to-invoker\` (\`~/.cursor/skills/invoker-plan-to-invoker/SKILL.md\` or \`~/.claude/skills/invoker-plan-to-invoker/SKILL.md\`). Fill Goal / Motivation / Safety invariant from context. Run the planning completeness gate. \`auto_submit\` only when that gate passes; otherwise AskQuestion / clarify on this surface and do not submit.
- Announce the route in one line so the user can interrupt with “do it locally.”
- Explicit “do it locally” / “don’t use Invoker” in the current message wins.
- Dirty working tree alone does **not** force Invoker.
- If MCP and CLI are both missing: stay local.

## Local vs remote Invoker (conversational)

- Default: leave harness MCP pointed at local \`invoker-cli mcp\`.
- If the **current turn** names a host, IP, or SSH alias for Invoker (e.g. “use 1.2.3.4”, “on do1”, “ssh my-box”), best-effort retarget before submit:
  1. Probe: \`ssh -o BatchMode=yes -o ConnectTimeout=5 <spec> 'command -v invoker-cli'\` (exit 0 required).
  2. On success only: set the harness \`invoker\` MCP server to \`command: ssh\`, \`args: ["-o","BatchMode=yes","<spec>","invoker-cli","mcp"]\` (Claude/Cursor/OMP JSON or Codex TOML). Do not invent HTTP/SSE MCP.
  3. On probe failure: leave the local MCP entry unchanged and tell the user; do not clobber local.
- “Local” / “this machine” in the current turn restores local \`invoker-cli mcp\`.

Slash commands \`/invoker-plan-to-invoker\` and \`/plan-to-invoker\` always enter the skill.
Plain approval stops after workflow handoff; do not publish PRs unless the user asks.
`;

export const CLAUDE_HOOK_SCRIPT = `#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const additionalContext = ${JSON.stringify(EXECUTION_ROUTING_FRAGMENT.trim())};

function main() {
  try {
    JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  if (!additionalContext) return;
  process.stdout.write(\`\${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  })}\\n\`);
}

main();
`;
