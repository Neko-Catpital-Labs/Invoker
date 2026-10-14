# Plan-to-invoker efficacy — soft rubric

Use this to judge whether skill and repo guidance are helping. Implementation-plan prompt self-containment is now enforced as a hard gate; this rubric focuses on efficacy and ergonomics beyond pass/fail.

## Tier A — Mechanical (CI)

- `bash scripts/test-plan-to-invoker-skill.sh` exits 0.
- `bash skills/plan-to-invoker/scripts/test-fixtures.sh` exits 0 (existing fixture contract unchanged).
- `bash skills/plan-to-invoker/scripts/skill-doctor.sh <plan.yaml>` for representative plans.
- For implementation plans (`onFinish != none`), `skill-doctor` should fail prompt tasks missing `Files:`/`Change types:`/`Acceptance criteria:` blocks, zero-context prompt framing, or deterministic pass/fail expectations.
- Optional advisory run: `bash skills/plan-to-invoker/scripts/skill-doctor.sh --warn-delegation <plan.yaml>` to surface non-blocking hint improvements.

## Tier B — Hint quality (sampled)

- On **N** plans, score whether `Files:` / `Change types:` / `Acceptance criteria:` blocks are accurate and useful (not just present).
- Track false positives/negatives from strict lint to tune prompt quality without weakening hard constraints.

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
- Treat results as **signal to improve prompts and lint heuristics**, not an excuse to remove strict zero-context safety rails.

## Related docs

- `../SKILL.md`
- `task-patterns.md` § *Delegated execution hints*, § *Bugfix repro*
- `../scripts/lint-task-atomicity.sh --strict-delegation --warn-delegation`
