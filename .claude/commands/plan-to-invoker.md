---
description: Convert a plan into Invoker YAML tasks via the plan-to-invoker skill
argument-hint: [plan text or file path]
---

Use the `plan-to-invoker` skill for this request.

If `$ARGUMENTS` is provided:
- Treat it as the input plan context (free text or path to a plan file).
- Convert it into a validated Invoker YAML implementation plan following the skill workflow.

If `$ARGUMENTS` is empty:
- Ask the user for the plan text or plan file path to convert.

Always follow the `plan-to-invoker` skill instructions and references as the source of truth.
