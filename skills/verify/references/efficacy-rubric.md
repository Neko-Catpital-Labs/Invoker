# Verification efficacy rubric

This rubric keeps three related maintenance tracks distinct:

1. **Verify skill** — the instructions and control-invoker flow that route a
   request to the right proof command.
2. **Skill efficacy evals** — cases under `evals/verify/` that test whether the
   stated decision is correct for representative prompts. These evals reuse
   `scripts/run_skill_evals.py`.
3. **Feature-map index job** — the map-only catalog that keeps
   `skills/verify/references/features/` aligned with product testids and e2e
   entry points.

A passing check in one track does not establish efficacy in either of the
others. Report which track and tier produced the evidence.

## Tiers

### Tier A — mechanical CI

Tier A is the cheap, deterministic merge signal:

- `bash scripts/test-verify-skill.sh` must exit 0.
- The script may run the hermetic case-catalog consistency check via
  `node skills/verify/control-invoker.mjs catalog --check`.
- The check may inspect files, frontmatter, commands, and testids, but must not
  attach to a user's live window, call an LLM, or edit `packages/`.

Tier A proves that the verification skill's fixtures and mechanical index
contracts are internally consistent. It does not prove that an agent chose a
good proof command for a natural-language request.

### Tier B — sampled map quality

Tier B samples feature-map entries and checks that each selected surface has a
real user path, an actionable `prove:` command, current testids, and useful
gotchas. Samples should include both recently changed surfaces and older
entries so that a green catalog check cannot hide stale instructions.

Tier B is a quality review of the feature-map index. It is not a substitute for
the skill-routing evals or for exercising the product flow.

### Tier C — stated-decision harness

Tier C runs the cases in `evals/verify/` through
`scripts/run_skill_evals.py`. Each case records the stated decision and checks
that the request is routed to the appropriate verify behavior, including when
the correct decision is to stay silent for a non-UI change. Cases should make
the expected decision explicit and distinguish the verify skill from the
feature-map index job.

Tier C measures skill efficacy on a repeatable prompt/case set. It is an LLM
or harness evaluation, not a replacement for Tier A's deterministic checks.

### Tier D — second-agent stress

Tier D asks an independent second agent to stress the boundaries between the
three tracks: product proof, verify-skill instructions, skill efficacy evals,
and map maintenance. The reviewer should try ambiguous prompts, stale-map
scenarios, and requests that must not attach to a live window or edit
`packages/`. Record disagreements and add a deterministic case or rubric
clarification when the disagreement reveals an unencoded contract.

## CI matrix (v1)

| Track | Tier A / merge signal | Higher-tier evidence | v1 policy |
| --- | --- | --- | --- |
| Verify skill | `bash scripts/test-verify-skill.sh` | Tier C and Tier D | Mechanical checks are merge-gate eligible; LLM evaluation is not merge-queue-required. |
| Skill efficacy evals | Fixture and harness integrity where applicable | `evals/verify/` via `scripts/run_skill_evals.py` | Run deliberately and report results; do not make the LLM run a required merge-queue check in v1. |
| Feature-map index job | Hermetic `catalog --check` (it may run inside `test-verify-skill.sh`) | Tier B sampled review | Keep this map-only; periodic maintenance repairs or reindexes entries and must never edit `packages/`. |

The v1 merge gate is therefore the deterministic Tier A surface. Tier B–D
evidence raises confidence and catches quality or routing drift, but an LLM
run is **not** merge-queue-required in v1.
