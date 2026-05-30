# INV-63 Experiment Brief

## Goal

Establish deterministic experiment proof for INV-63.

## Motivation

Ensure architecture choices are evidence-backed and reviewable before downstream
implementation work consumes the plan-to-invoker skill contract.

## Files Under Test

- `skills/plan-to-invoker/SKILL.md`
- `.cursor/skills/plan-to-invoker/SKILL.md`
- `skills/plan-to-invoker/scripts/skill-doctor.sh`

## Evidence From Inspection

- Both skill entrypoints describe the same deterministic plan-to-invoker
  controller contract, including the primary command
  `bash skills/plan-to-invoker/scripts/skill-doctor.sh <plan-file>`.
- Both skill entrypoints require experiment prompt tasks to write a deterministic
  artifact path such as `docs/context/<issue>/experiment-brief.md`, commit it,
  and require dependent implementation tasks to reference that exact artifact.
- Both skill entrypoints define local deterministic validation surfaces:
  assumption extraction, verify-plan generation, YAML validation, atomicity
  linting, parse-results validation, and policy-matrix coverage checks.
- `skills/plan-to-invoker/scripts/skill-doctor.sh` implements those checks as
  local shell orchestration, emits a JSON summary with `allPassed`,
  `firstFailedStep`, and per-check statuses, and exits with deterministic codes:
  `0` for pass, `1` for check failure, and `2` for usage or argument errors.

## Selected Approach

Use `skill-doctor.sh` as the reviewable validation gate and prove the skill
contract around it with local deterministic commands. This approach is selected
because the skill files explicitly designate `skill-doctor.sh` as the primary
validation surface, and the script centralizes pass/fail thresholds into stable
exit codes plus machine-readable JSON.

## Competing Alternatives

- Use only static grep checks against the skill files. This is rejected as the
  primary proof because the skill text says grep-only checks are Phase 1a only
  and behavioral claims require executed Phase 1b evidence.
- Submit an Invoker headless workflow as the experiment proof. This is rejected
  for this brief because the requested artifact needs deterministic local
  commands without external services.
- Treat `.cursor/skills/plan-to-invoker/SKILL.md` as advisory and validate only
  `skills/plan-to-invoker/SKILL.md`. This is rejected because the user explicitly
  required both skill files under test, and divergence between them would make
  architecture choices less reviewable.

## Deterministic Local Commands

Run all commands from the repository root. These commands do not require network
access or external services.

### 1. Verify Skill Mirrors Match

Command:

```bash
cmp -s skills/plan-to-invoker/SKILL.md .cursor/skills/plan-to-invoker/SKILL.md
```

Expected output:

```text
<no stdout>
```

Expected exit code:

```text
0
```

Verdict and threshold:

- Pass: exit code is `0`, proving the two skill entrypoints are byte-identical.
- Fail: any nonzero exit code, proving the skill entrypoints diverge and must be
  reconciled before architecture decisions can rely on a single contract.

### 2. Verify Required Experiment Policy Is Present In Both Skill Entrypoints

Command:

```bash
rg -n "Experiment artifact persistence rule|deterministic pass/fail expectations|bash skills/plan-to-invoker/scripts/skill-doctor.sh <plan-file>" skills/plan-to-invoker/SKILL.md .cursor/skills/plan-to-invoker/SKILL.md
```

Expected output pattern:

```text
skills/plan-to-invoker/SKILL.md:<line>:**Experiment artifact persistence rule ...
.cursor/skills/plan-to-invoker/SKILL.md:<line>:**Experiment artifact persistence rule ...
skills/plan-to-invoker/SKILL.md:<line>:... deterministic pass/fail expectations ...
.cursor/skills/plan-to-invoker/SKILL.md:<line>:... deterministic pass/fail expectations ...
skills/plan-to-invoker/SKILL.md:<line>:bash skills/plan-to-invoker/scripts/skill-doctor.sh <plan-file>
.cursor/skills/plan-to-invoker/SKILL.md:<line>:bash skills/plan-to-invoker/scripts/skill-doctor.sh <plan-file>
```

Verdict and threshold:

- Pass: at least one match for each required phrase appears in each skill file.
- Fail: any required phrase is absent from either skill file.

### 3. Verify `skill-doctor.sh` Help And Exit-Code Contract

Command:

```bash
bash skills/plan-to-invoker/scripts/skill-doctor.sh --help
```

Expected output pattern:

```text
skill-doctor.sh: Deterministic orchestrator for plan validation scripts
Usage: bash skill-doctor.sh [OPTIONS] <plan-file>
...
Exit codes:
  0 = all checks passed
  1 = one or more checks failed
```

Verdict and threshold:

- Pass: command exits `0` and prints usage plus the `0` and `1` exit-code
  meanings.
- Fail: command exits nonzero or omits the usage/exit-code contract.

### 4. Verify Usage Errors Are Deterministic

Command:

```bash
bash skills/plan-to-invoker/scripts/skill-doctor.sh >/tmp/inv-63-skill-doctor-missing-plan.out 2>/tmp/inv-63-skill-doctor-missing-plan.err; echo "$?"
```

Expected stdout pattern:

```text
2
```

Expected stderr pattern in `/tmp/inv-63-skill-doctor-missing-plan.err`:

```text
ERROR: Plan file argument required
Usage: bash skill-doctor.sh [OPTIONS] <plan-file>
```

Verdict and threshold:

- Pass: echoed exit code is `2` and stderr contains the missing-plan error.
- Fail: any other exit code, missing stderr message, or nondeterministic prompt.

### 5. Verify Script Implements JSON Summary Thresholds

Command:

```bash
rg -n "allPassed|firstFailedStep|checks:|exit 1|exit 0|exit 2" skills/plan-to-invoker/scripts/skill-doctor.sh
```

Expected output pattern:

```text
skills/plan-to-invoker/scripts/skill-doctor.sh:<line>:... allPassed ...
skills/plan-to-invoker/scripts/skill-doctor.sh:<line>:... firstFailedStep ...
skills/plan-to-invoker/scripts/skill-doctor.sh:<line>:... checks ...
skills/plan-to-invoker/scripts/skill-doctor.sh:<line>:  exit 1
skills/plan-to-invoker/scripts/skill-doctor.sh:<line>:exit 0
```

Verdict and threshold:

- Pass: output includes JSON summary fields `allPassed`, `firstFailedStep`, and
  `checks`, plus deterministic terminal exits for failure and success.
- Fail: any summary field or terminal pass/fail exit path is absent.

## Reviewable Pass/Fail Threshold

INV-63 experiment proof passes when all of the following are true:

- The two skill files under test are byte-identical.
- Both skill files contain the experiment artifact persistence rule, deterministic
  pass/fail expectation language, and the primary `skill-doctor.sh` command.
- `skill-doctor.sh --help` exits `0` and documents usage plus exit-code
  semantics.
- Calling `skill-doctor.sh` without a plan file exits `2` with a stable usage
  error.
- `skill-doctor.sh` contains JSON summary fields and deterministic terminal
  pass/fail exits.

The proof fails if any command above misses its expected output pattern or exit
threshold.
