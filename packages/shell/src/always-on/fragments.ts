export const EXECUTION_ROUTING_FRAGMENT = `# Invoker execution routing

When Invoker MCP (\`invoker_prepare_plan_review\` / \`invoker_submit_plan\`) or \`invoker-cli\` is available:

- Read-only questions: stay local.
- Stay in this chat when **all** hold: current repo only; one review slice / one layer; feature iteration on existing files or a one-file bug with a local repro.
- Delegate to Invoker when **any** hold: more than one layer, review slice, package boundary, or PR-worthy commit; cross-repo; overnight / user stepping away; agent self-routes mid-task.
- First action on delegate: read \`invoker-chat-submit\` then \`invoker-plan-to-invoker\`. Fill Goal / Motivation / Safety invariant from context. Run the planning completeness gate. \`auto_submit\` only when that gate passes; otherwise AskQuestion / clarify on this surface and do not submit.
- Announce the route in one line so the user can interrupt with “do it locally.”
- Explicit “do it locally” / “don’t use Invoker” in the current message wins.
- Dirty working tree alone does **not** force Invoker.
- If MCP and CLI are both missing: stay local.

Slash commands \`/invoker-plan-to-invoker\` and \`/plan-to-invoker\` always enter the skill.
Plain approval stops after workflow handoff; do not publish PRs unless the user asks.
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
- If MCP and CLI are both missing: stay local.

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
