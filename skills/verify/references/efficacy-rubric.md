# Verify-skill efficacy rubric

Use this rubric to judge whether the verify skill helps an agent choose and
prove the right verification path. It separates three maintenance tracks:

1. **Verify skill contract** — the instructions, fixtures, and mechanical
   checks that define how `skills/verify` is used.
2. **Skill efficacy evaluations** — sampled stated decisions that test whether
   an agent selects the right path and respects the safety boundaries. These
   live under `evals/verify/` and reuse `scripts/run_skill_evals.py`.
3. **Feature-map index job** — the inventory of UI surfaces, testids, and prove
   commands under `skills/verify/references/features/`. This is maintained by
   `catalog --check` and the periodic map-only repair/reindex loop.

## Tier A — Mechanical CI

These are deterministic contract checks and are suitable for merge-queue CI:

- `bash scripts/test-verify-skill.sh` exits 0.
- `node skills/verify/control-invoker.mjs catalog --check` exits 0.
- The verify fixtures and router tests continue to pass.
- A hermetic case-catalog check for `evals/verify/` may run inside
  `test-verify-skill.sh`; it must not attach to a live window, call an LLM, or
  edit `packages/`.

Tier A proves that the documented machinery is present and internally
consistent. It does not prove that an agent made a good decision on a novel
prompt.

## Tier B — Sampled map quality

On a representative sample of feature-map entries, inspect whether:

- the user path is accurate and repeatable;
- `prove:` names an existing, appropriately scoped command;
- listed testids and related e2e/repro coverage still exist; and
- gotchas identify live-window, stale-build, or other safety boundaries.

Record missing, stale, and misleading entries separately. This track repairs
the index; it does not silently change product behavior or packages.

## Tier C — Evals / stated-decision harness

Run the paired baseline/candidate harness against the cases in `evals/verify/`
using `scripts/run_skill_evals.py`. Score the agent's stated decision, not just
whether a command can be made to pass:

- Did it recognize when the verify skill applies?
- Did it select the correct `prove`, catalog, or non-UI path?
- Did it identify the relevant feature-map entry and evidence needed?
- Did it avoid live-window attach, unsupported claims, and out-of-scope edits?

Use the same case catalog and scoring dimensions before and after instruction
changes. Tier C is an efficacy signal and is not an LLM merge-queue requirement
in v1; only its hermetic catalog validation belongs in the Tier A matrix.

## Tier D — Second-agent stress

Have an independent agent execute representative cases from the task
description and the relevant skill docs alone. Count wrong routing, unnecessary
clarifying questions, unsupported completion claims, and edits outside the
declared track. Use the results to improve the skill or fixtures. The second
agent is an evaluation of the instructions, not an owner of the feature-map
index.

## CI and ownership matrix

| Track | Primary artifact | Required in merge queue (v1) | Owner of repair |
| --- | --- | --- | --- |
| Verify skill contract | `skills/verify/SKILL.md`, fixtures, contract tests | Yes; Tier A | Verify-skill maintainer |
| Skill efficacy evals | `evals/verify/`, paired stated-decision runs | No LLM run; hermetic catalog check may be Tier A | Evals maintainer |
| Feature-map index job | `references/features/`, `catalog --check` | Yes; cheap consistency check | Maintain-verify maintainer |

## Related docs

- `../SKILL.md`
- `../../maintain-verify/SKILL.md`
- `../../../evals/verify/` (when the case catalog is present)
