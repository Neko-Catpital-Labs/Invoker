# Plan-to-invoker efficacy — soft rubric

Use this to judge whether skill and repo guidance are helping. **Scores are qualitative** unless you explicitly turn warnings into gates (not the default).

## Tier A — Mechanical (CI)

- `bash scripts/test-plan-to-invoker-skill.sh` exits 0.
- `bash skills/plan-to-invoker/scripts/test-fixtures.sh` exits 0 (existing fixture contract unchanged).
- `bash skills/plan-to-invoker/scripts/skill-doctor.sh <plan.yaml>` for representative plans.
Reporting-only: `bash skills/plan-to-invoker/scripts/skill-doctor.sh --warn-delegation <plan.yaml>` then inspect stderr for delegation-hint warnings; **do not** require zero warnings to merge.

## Tier B — Hint coverage (sampled)

- On **N** plans, note how many tasks include `Files:` / `Change types:` / `Acceptance criteria:` in `description`.
- **Aspirational targets only** — not merge blockers.

## Tier C — Golden prompts (before / after)

Use the **same** prompts after process or doc changes; score **softly** (e.g. 0–3 per prompt).

Suggested prompts:

1. Feature plan: “Add X to package Y” via `/plan-to-invoker …`
2. Bugfix: “Error Z when …” — check whether a repro script or shared command is **proposed** (nice-to-have).
3. Precedence: `/plan-to-invoker` plus trailing “just implement removing X” — does the agent **still** run the skill workflow before editing `packages/`?
4. Handoff: “Another agent will run task **id** only” — are descriptions skimmable?

Checklist examples (binary where obvious, soft otherwise):

- Did not edit product code before `skill-doctor` + user confirm on the plan-to-invoker path.
- Most tasks have **useful** Files/Acceptance hints when you reread the YAML (subjective).

## Tier D — Second-agent stress

- Execute from YAML alone; count clarifying questions and edits outside any listed paths.
- Treat results as **signal to improve prompts**, not proof of lint violations (lists are best effort).

## Related docs

- `../SKILL.md`
- `task-patterns.md` § *Delegated execution hints*, § *Bugfix repro*
- `../scripts/lint-task-atomicity.sh --warn-delegation`
