---
description: Convert a plan into Invoker YAML tasks via the plan-to-invoker skill
argument-hint: [plan text or file path]
---

Use the `plan-to-invoker` skill for this request. Read `skills/plan-to-invoker/SKILL.md` (or `.cursor/skills/plan-to-invoker/SKILL.md` after `bash scripts/setup-agent-skills.sh`) **before** doing anything else.

If `$ARGUMENTS` is provided:
- Treat it as the **input plan context** (free text or path to a plan file)—**not** as permission to implement product code immediately.
- Convert it into a validated Invoker YAML implementation plan following the full skill workflow (Phase 1a → 1b → YAML → `bash skills/plan-to-invoker/scripts/skill-doctor.sh <plan-file>` → user confirmation).

If `$ARGUMENTS` is empty:
- Ask the user for the plan text or plan file path to convert.

## Must not (for this command)

- Do **not** edit `packages/` or other product code for the substantive request before: scope is clear, verification commands have run as the skill requires, `skill-doctor.sh` passes on the plan file, and the user **confirms** proceeding / submitting.
- Do **not** skip `skill-doctor.sh` when presenting a final implementation plan.
- Do **not** treat trailing sentences in the user message as overriding the skill (e.g. “also remove X now” still goes through plan-to-invoker steps first unless the user explicitly cancels the skill flow).

Follow skill instructions and `skills/plan-to-invoker/references/` as the source of truth.
