# INV-63 Experiment Brief

## Goal

Establish deterministic experiment proof for INV-63 by anchoring every architecture
claim to a copy-pasteable shell command that produces a binary, machine-checkable
pass/fail signal. Reviewers should not need to grep source files by eye or compare
ad-hoc summaries — every claim is backed by `bash skills/plan-to-invoker/scripts/skill-doctor.sh`
runs whose exit code and JSON summary fields (`allPassed`, `firstFailedStep`,
`checks[]`) decide the verdict.

## Files under test

The deterministic surface covered by this brief is composed of three files in this
repository (paths are repo-relative):

- `skills/plan-to-invoker/SKILL.md` — the canonical controller skill that names
  `bash skills/plan-to-invoker/scripts/skill-doctor.sh <plan-file>` as the primary
  validation surface and lists the fallback debugging commands.
- `.cursor/skills/plan-to-invoker/SKILL.md` — the Cursor-side mirror of the
  controller skill. Both copies must keep the same deterministic command map so the
  Cursor and CLI runners point at the same evidence.
- `skills/plan-to-invoker/scripts/skill-doctor.sh` — the orchestrator script that
  composes `extract-assumptions.sh`, `generate-verify-plan.sh`,
  `check-policy-coverage.sh`, `validate-plan.sh`, `lint-task-atomicity.sh`, and
  `parse-results.sh` and emits the JSON summary used by these verdicts. Documented
  exit codes: `0 = all checks passed`, `1 = one or more checks failed`,
  `2 = usage/argument error`.

## Deterministic commands

Every claim in this brief is checked by one of the commands below. The commands are
intentionally copy-pasteable — no placeholders, no `<...>` tokens — and must be run
from the repository root.

Positive fixture run — claim: a known-good plan passes every sub-check inside
`skill-doctor.sh` and produces `allPassed: true`:

```bash
bash skills/plan-to-invoker/scripts/skill-doctor.sh \
  skills/plan-to-invoker/fixtures/positive/01-minimal-verification.yaml
```

Positive fixture run, machine-checked exit code — claim: the orchestrator's
documented exit code contract holds for the positive fixture:

```bash
bash skills/plan-to-invoker/scripts/skill-doctor.sh \
  skills/plan-to-invoker/fixtures/positive/01-minimal-verification.yaml \
  > /tmp/inv-63-skill-doctor.json
echo "exit=$?"
```

Positive fixture run, JSON summary assertion — claim: the JSON summary fields
`allPassed` and `firstFailedStep` carry the documented pass-shape on the known-good
fixture:

```bash
bash skills/plan-to-invoker/scripts/skill-doctor.sh \
  skills/plan-to-invoker/fixtures/positive/01-minimal-verification.yaml \
  | jq -e '.allPassed == true and .firstFailedStep == null'
```

Negative fixture run — claim: a known-bad plan fails at least one sub-check and the
orchestrator reports the first failing step. The
`anti-pattern-a-npx-vitest.yaml` fixture is the canonical negative input:

```bash
bash skills/plan-to-invoker/scripts/skill-doctor.sh \
  skills/plan-to-invoker/fixtures/negative/anti-pattern-a-npx-vitest.yaml \
  ; echo "exit=$?"
```

Negative fixture run, JSON summary assertion — claim: the JSON summary marks the
known-bad fixture as failing and names a non-null `firstFailedStep`:

```bash
bash skills/plan-to-invoker/scripts/skill-doctor.sh \
  skills/plan-to-invoker/fixtures/negative/anti-pattern-a-npx-vitest.yaml \
  | jq -e '.allPassed == false and (.firstFailedStep | type) == "string"' \
  ; echo "exit=$?"
```

Usage-error claim — claim: invoking the orchestrator without a plan file produces
the documented usage exit code `2` (distinct from the failure code `1`):

```bash
bash skills/plan-to-invoker/scripts/skill-doctor.sh ; echo "exit=$?"
```

## Expected outputs

For each command above the expected output is a deterministic stdout shape (the
JSON summary printed by `skill-doctor.sh`) plus an exit code, so reviewers can
compare verbatim:

- Positive fixture run on
  `skills/plan-to-invoker/fixtures/positive/01-minimal-verification.yaml` —
  process exit code `0` and a JSON object whose top-level shape matches:

  ```json
  {
    "planFile": "skills/plan-to-invoker/fixtures/positive/01-minimal-verification.yaml",
    "allPassed": true,
    "firstFailedStep": null,
    "checks": [
      { "stepId": "extract-assumptions",  "status": "passed" },
      { "stepId": "generate-verify-plan", "status": "passed" },
      { "stepId": "check-policy-coverage","status": "passed" },
      { "stepId": "validate-plan",        "status": "passed" },
      { "stepId": "lint-task-atomicity",  "status": "passed" },
      { "stepId": "parse-results",        "status": "passed" }
    ]
  }
  ```

  The `checks[]` array is composed by `skill-doctor.sh` in the order shown above;
  the per-entry `message` and `output` fields may vary but `status` must be
  `"passed"` for every entry and `allPassed` must be `true`.

- Positive fixture run, machine-checked exit code — stdout ends with the literal
  fragment `exit=0`.

- Positive fixture run, JSON summary assertion — `jq -e` exits `0` (silent stdout
  is the expected shape; failure would print `false` and exit non-zero).

- Negative fixture run on
  `skills/plan-to-invoker/fixtures/negative/anti-pattern-a-npx-vitest.yaml` —
  process exit code `1`, a stderr line beginning with `ERROR: First failed step:`,
  and a JSON summary with `"allPassed": false` plus a non-null
  `"firstFailedStep"` naming the first failing sub-check (typically
  `lint-task-atomicity` for this fixture). Stdout ends with the literal fragment
  `exit=1`.

- Negative fixture run, JSON summary assertion — `jq -e` exits `0` (the assertion
  is `.allPassed == false and firstFailedStep is a string`). Stdout ends with the
  literal fragment `exit=0`.

- Usage-error claim — stderr contains `ERROR: Plan file argument required` and
  stdout ends with the literal fragment `exit=2`.

## Verdicts

Each command above pairs to a single pass/fail verdict so reviewers can mark the
brief without re-reading the source. A `pass` verdict requires both the exit code
and the JSON summary shape to match; partial matches are `fail`.

- Positive fixture run on `01-minimal-verification.yaml`
  - pass: exit code `0` and JSON `allPassed == true` and
    `firstFailedStep == null`.
  - fail: any non-zero exit code, or `allPassed != true`, or
    `firstFailedStep != null`.
- Positive fixture run, machine-checked exit code
  - pass: stdout contains `exit=0`.
  - fail: stdout contains any other `exit=` value.
- Positive fixture run, JSON summary assertion
  - pass: `jq -e` exits `0` (assertion held).
  - fail: `jq -e` exits non-zero (assertion failed or JSON was malformed).
- Negative fixture run on `anti-pattern-a-npx-vitest.yaml`
  - pass: exit code `1` and JSON `allPassed == false` and a non-null string
    `firstFailedStep`.
  - fail: exit code `0` (the orchestrator missed the regression), or `allPassed`
    is anything other than `false`, or `firstFailedStep` is `null`.
- Negative fixture run, JSON summary assertion
  - pass: `jq -e` exits `0` against the negative fixture's JSON summary.
  - fail: `jq -e` exits non-zero.
- Usage-error claim
  - pass: exit code `2` and stderr names the missing plan argument.
  - fail: any other exit code (in particular `0` or `1`, which would conflate
    usage errors with pass/fail signals).

## Thresholds

Thresholds are intentionally numeric so the brief can be re-evaluated by a script
without judgement calls:

- Positive fixture pass threshold (must all hold):
  - process exit code `== 0`
  - `summary.allPassed == true`
  - `summary.firstFailedStep == null`
  - every entry in `summary.checks[].status == "passed"`
- Positive fixture fail threshold (any one is enough to fail the experiment):
  - process exit code `!= 0`
  - `summary.allPassed != true`
  - `summary.firstFailedStep != null`
- Negative fixture pass threshold (must all hold to count the regression as
  caught):
  - process exit code `== 1`
  - `summary.allPassed == false`
  - `summary.firstFailedStep` is a non-empty string
- Negative fixture fail threshold (any one is enough to fail the experiment):
  - process exit code `== 0` (the orchestrator silently accepted a bad plan)
  - `summary.allPassed == true`
  - `summary.firstFailedStep == null`
- Usage-error threshold:
  - process exit code `== 2` on missing/extra arguments (must not collide with
    `1` for genuine failures, nor `0` for success).

The experiment is considered conclusive only when every threshold above is met for
both the positive and negative fixtures in a single run; partial coverage is not
sufficient.

## Alternatives

Two options were considered for delivering the INV-63 deterministic proof:

- Rejected: ad-hoc reviewer grep over `skills/plan-to-invoker/` plus reading
  source files by eye. This was rejected because it is non-deterministic (two
  reviewers can reach different conclusions on the same diff), it produces no
  machine-checkable pass/fail signal, and reviewer fatigue scales with file
  count, so the proof would degrade as the skill surface grows. There is also no
  obvious way to wire ad-hoc grep verdicts into CI or a workflow gate.
- Selected: run `skills/plan-to-invoker/scripts/skill-doctor.sh` against the
  fixtures listed under `## Files under test` and inspect the structured JSON
  summary (`planFile`, `allPassed`, `firstFailedStep`, `checks[]`) together with
  the documented exit codes (`0` pass, `1` failure, `2` usage). This option was
  selected because the orchestrator already composes the deterministic surface
  this brief needs (assumption extraction, verify-plan generation, schema
  validation, atomicity linting, parse-results), produces a binary verdict per
  sub-check, and emits a JSON summary that downstream tools (`jq`, CI gates,
  follow-on Invoker workflows) can consume without re-reading the script's
  internals.

### Alternative considerations

The same trade-off, stated in the rationale headings used by
`lint-task-atomicity.sh`, so this brief plugs cleanly into a follow-on
implementation plan:

- Review claim: every architecture claim for INV-63 is backed by a
  copy-pasteable `skill-doctor.sh` invocation whose exit code and JSON summary
  decide the verdict.
- Safety invariant: the brief never asks a reviewer to trust prose without a
  command — if a claim cannot be tied to a deterministic command, it is removed
  from the brief rather than softened.
- Slice rationale: the brief is intentionally limited to the three files listed
  under `## Files under test` so the deterministic surface stays small enough to
  re-run end-to-end on every review.
- Architectural effect: future INV-63 follow-ups can cite this brief as the
  single source of truth for what "deterministic" means in this workstream,
  avoiding drift between the SKILL.md copies and the orchestrator script.
