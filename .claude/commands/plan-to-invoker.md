---
description: Convert a plan into Invoker YAML tasks via the plan-to-invoker skill
argument-hint: [plan text or file path]
---

Use the `plan-to-invoker` skill for this request. Read `skills/plan-to-invoker/SKILL.md` before doing anything else.

If `$ARGUMENTS` contains benchmark/direct-output signals such as `For this benchmark`, `Required output path:`, `Write the final YAML plan to`, or `Do not submit the plan`, follow the skill's benchmark/direct-output mode immediately. In that mode, write a complete YAML document to the literal required path. The file must start with top-level `name:` and include top-level `onFinish:`, `mergeMode:`, `repoUrl:`, and `tasks:` before any task content; do not write `version:` or `metadata:` wrappers.

If `$ARGUMENTS` is provided:
- Treat it as the input plan context (free text or path to a plan file).
- Convert it into a validated Invoker YAML implementation plan following the skill workflow.

If `$ARGUMENTS` is empty:
- Ask the user for the plan text or plan file path to convert.

Always follow the `plan-to-invoker` skill instructions and references as the source of truth.
