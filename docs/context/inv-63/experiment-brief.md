# INV-63 experiment brief

This brief records the deterministic experiment used to decide how the INV-63
architecture choice is verified. Every claim must be reproducible by running
the commands below from the repository root and comparing their stdout and
exit codes against the "Expected outputs" and "Verdict rules" sections.

## Files under test

The experiment evaluates the contract published by the plan-to-invoker skill,
exercised through these three files (paths are verbatim and relative to the
repo root):

- `skills/plan-to-invoker/SKILL.md`
- `.cursor/skills/plan-to-invoker/SKILL.md`
- `skills/plan-to-invoker/scripts/skill-doctor.sh`

`skills/plan-to-invoker/SKILL.md` and `.cursor/skills/plan-to-invoker/SKILL.md`
hold the canonical and Cursor-attached policy text (review-compression
requirements, the eight required rationale headings, the experiment-artifact
persistence rule). `skills/plan-to-invoker/scripts/skill-doctor.sh` is the
single deterministic validator they both delegate to.

## Designs under evaluation

**Selected design — single self-contained brief under `docs/context/inv-63/`.**
One Markdown file holds the file list, the deterministic command surface, the
expected outputs, the verdict table, and the numeric thresholds. Reviewers
open one path, re-run the commands, and reach a verdict without cross
referencing.

**Alternative design — split brief (JSON fixture + narrative file).**
A `proof.json` would carry machine-readable expected outputs alongside a
`brief.md` narrative. This design separates data from prose, but reviewers
must keep both files in sync and load two contexts to reach a verdict.

Trade-off comparison: the selected design optimises *reviewability* (single
file, single grep target, no cross-file drift) and *determinism* (commands
and expected outputs live next to each other, so a stale fixture can't
silently disagree with the narrative). It costs slightly on *machine
consumption*: a downstream automation that wants structured pass/fail data
would need to parse Markdown rather than read JSON. The alternative wins on
machine consumption but loses on the other two axes, and the workflow
already produces JSON directly from `skill-doctor.sh`, so the JSON fixture
would duplicate that artifact. The selected design wins on the criteria
that matter for an evidence-backed architecture review.

## Deterministic commands

Each design is verified by running `skill-doctor.sh` against two fixtures —
one expected to pass, one expected to fail — so a green run is distinguished
from a no-op. Commands assume the repo root as the working directory.

Positive fixture (a minimal valid plan):

```bash
bash skills/plan-to-invoker/scripts/skill-doctor.sh \
  skills/plan-to-invoker/fixtures/positive/01-minimal-verification.yaml
```

Negative fixture (an anti-pattern plan that uses `npx vitest` instead of
`pnpm test`):

```bash
bash skills/plan-to-invoker/scripts/skill-doctor.sh \
  skills/plan-to-invoker/fixtures/negative/anti-pattern-a-npx-vitest.yaml
```

Heading-count check on the brief itself (sanity that the artifact this
workflow produces still carries every required section):

```bash
grep -c -E '^## (Files under test|Designs under evaluation|Deterministic commands|Expected outputs|Verdict rules|Thresholds)$' \
  docs/context/inv-63/experiment-brief.md
```

## Expected outputs

Positive fixture — `skill-doctor.sh` prints a JSON summary whose
`allPassed` key is the boolean literal `true`, and the process exits with
code `0`:

```text
{
  "planFile": "skills/plan-to-invoker/fixtures/positive/01-minimal-verification.yaml",
  "allPassed": true,
  "firstFailedStep": null,
  "checks": [ ... ]
}
exit code: 0
```

Negative fixture — `skill-doctor.sh` prints a JSON summary whose
`allPassed` key is the boolean literal `false`, sets `firstFailedStep` to a
non-null string, and the process exits with code `1`:

```text
{
  "planFile": "skills/plan-to-invoker/fixtures/negative/anti-pattern-a-npx-vitest.yaml",
  "allPassed": false,
  "firstFailedStep": "lint-task-atomicity",
  "checks": [ ... ]
}
exit code: 1
```

Heading-count check — `grep -c` prints exactly the integer `6` (one match
per required `##` heading) and exits with code `0`:

```text
6
exit code: 0
```

## Verdict rules

| Command | Expected output | Verdict |
| --- | --- | --- |
| `bash skills/plan-to-invoker/scripts/skill-doctor.sh skills/plan-to-invoker/fixtures/positive/01-minimal-verification.yaml` | JSON `"allPassed": true` and exit code `0` | pass |
| `bash skills/plan-to-invoker/scripts/skill-doctor.sh skills/plan-to-invoker/fixtures/positive/01-minimal-verification.yaml` | JSON `"allPassed": false` or exit code != `0` | fail |
| `bash skills/plan-to-invoker/scripts/skill-doctor.sh skills/plan-to-invoker/fixtures/negative/anti-pattern-a-npx-vitest.yaml` | JSON `"allPassed": false` and exit code `1` | pass |
| `bash skills/plan-to-invoker/scripts/skill-doctor.sh skills/plan-to-invoker/fixtures/negative/anti-pattern-a-npx-vitest.yaml` | JSON `"allPassed": true` or exit code `0` | fail |
| `grep -c -E '^## (...)$' docs/context/inv-63/experiment-brief.md` | stdout `6` and exit code `0` | pass |
| `grep -c -E '^## (...)$' docs/context/inv-63/experiment-brief.md` | stdout != `6` or exit code != `0` | fail |

A green experiment requires **all three "pass" rows above to match** in a
single uninterrupted run. Any single fail-row match invalidates the
experiment.

## Thresholds

Numeric pass/fail thresholds — every signal here is measurable and
mechanically checkable:

1. **skill-doctor exit code (positive fixture):** must equal `0`. Any other
   value fails the experiment. Source: `skill-doctor.sh` lines 16-19 define
   `0 = all checks passed`, `1 = one or more checks failed`,
   `2 = usage/argument error`.
2. **skill-doctor exit code (negative fixture):** must equal `1`. Exit `0`
   would mean the validator silently accepted the anti-pattern; exit `2`
   would mean the invocation itself was malformed. Either outcome fails
   the experiment.
3. **Required rationale headings per prompt task:** must be `>= 8`. The
   eight required headings, enforced by `lint-task-atomicity.sh` under
   `skill-doctor.sh`, are: `Review claim`, `Safety invariant`,
   `Slice rationale`, `Architectural effect`, `Goal`, `Motivation`,
   `Alternative considerations`, `Implementation details`. Source:
   `skills/plan-to-invoker/SKILL.md` line 34 and
   `.cursor/skills/plan-to-invoker/SKILL.md` line 34.
4. **Required level-2 headings in this brief:** must equal `6` (matches
   the six `##` headings: Files under test, Designs under evaluation,
   Deterministic commands, Expected outputs, Verdict rules, Thresholds).
   The grep command above is the deterministic check.
5. **Files-under-test verbatim citations:** must equal `3` distinct
   string matches for `skills/plan-to-invoker/SKILL.md`,
   `.cursor/skills/plan-to-invoker/SKILL.md`, and
   `skills/plan-to-invoker/scripts/skill-doctor.sh`. Fewer than three
   means the brief lost evidence traceability.
