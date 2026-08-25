export const EXECUTION_ROUTING_FRAGMENT = `# Invoker execution routing

When Invoker MCP (\`invoker_prepare_plan_review\` / \`invoker_submit_plan\`) or \`invoker-cli\` is available:

- Read-only questions: stay local.
- Tiny edits (one file, not a feature, working tree clean): stay local.
- Feature-sized work, multi-file changes, or a dirty working tree: do not implement locally. First action: read the installed \`invoker-plan-to-invoker\` skill, then plan, review, one approval, submit.
- Announce the route in one line so the user can interrupt with “do it locally.”
- Explicit “do it locally” / “don’t use Invoker” in the current message wins.
- If MCP and CLI are both missing: stay local.

Slash commands \`/invoker-plan-to-invoker\` and \`/plan-to-invoker\` always enter the skill.
Plain approval stops after workflow handoff; do not publish PRs unless the user asks.
`;

export const CURSOR_RULE_CONTENTS = `---
description: Feature work and dirty-tree edits go through Invoker; tiny clean-tree edits stay local
alwaysApply: true
---

# Invoker execution routing

When Invoker MCP (\`invoker_prepare_plan_review\` / \`invoker_submit_plan\`) or \`invoker-cli\` is available:

- Read-only questions: stay local.
- Tiny edits (one file, not a feature, working tree clean): stay local.
- Feature-sized work, multi-file changes, or a dirty working tree: do not implement locally. First action: read the installed \`invoker-plan-to-invoker\` skill (\`~/.cursor/skills/invoker-plan-to-invoker/SKILL.md\` or \`~/.claude/skills/invoker-plan-to-invoker/SKILL.md\`), then plan, review, one approval, submit.
- Announce the route in one line so the user can interrupt with “do it locally.”
- Explicit “do it locally” / “don’t use Invoker” in the current message wins.
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
