# INV-63 deterministic experiment brief

## Goal

Establish deterministic experiment proof for INV-63 so architecture choices are evidence-backed and reviewable.

## Files under test

- `skills/plan-to-invoker/SKILL.md`
- `.cursor/skills/plan-to-invoker/SKILL.md`
- `skills/plan-to-invoker/scripts/skill-doctor.sh`

## Selected approach

Use `skills/plan-to-invoker/scripts/skill-doctor.sh` as the deterministic proof harness for authored plan artifacts. This keeps validation centralized around the same contract used by the plan-to-invoker skill: assumption extraction, verify-plan generation, schema validation, atomicity linting, and verify-result parsing.

## Alternative considered

A lightweight grep-only proof was considered. It is cheaper to run, but it only demonstrates that selected strings exist. It does not prove that the plan can pass the validator chain or that generated verification output remains parseable. The selected approach is preferred because it produces a stronger pass/fail signal tied to executable behavior.

## Deterministic commands

### Command 1: required file presence

```bash
test -f skills/plan-to-invoker/SKILL.md
test -f .cursor/skills/plan-to-invoker/SKILL.md
test -f skills/plan-to-invoker/scripts/skill-doctor.sh
test -x skills/plan-to-invoker/scripts/skill-doctor.sh
```

Expected output: no stdout and exit code `0`.

Verdict threshold: all four checks must pass. Any missing or non-executable harness file is a failing result.

### Command 2: skill-doctor help surface

```bash
bash skills/plan-to-invoker/scripts/skill-doctor.sh --help
```

Expected output: usage text that names `--skip-assumptions`, `--skip-atomicity`, `--skip-validation`, `--source-file`, `--coverage-map`, `--stack-manifest`, and `--verbose`.

Verdict threshold: exit code `0`, and every listed option must appear exactly as a supported flag.

### Command 3: minimal isolated plan validation

```bash
tmp_plan="$(mktemp)"
cat > "$tmp_plan" <<'PLAN'
name: "INV-63 proof smoke"
onFinish: none
mergeMode: manual
repoUrl: "https://github.com/Neko-Catpital-Labs/Invoker.git"

tasks:
  - id: "smoke"
    description: "Verify deterministic command-only smoke execution for INV-63."
    command: "printf '%s\n' 'INV-63 deterministic smoke: pass' && test 1 -eq 1"
    dependencies: []
PLAN
bash skills/plan-to-invoker/scripts/skill-doctor.sh "$tmp_plan"
```

Expected output: JSON summary with successful validation checks and exit code `0`.

Verdict threshold: exit code `0`; the result must not degrade to a noop verification plan.

### Command 4: artifact persistence proof

```bash
git log -1 --name-only --pretty=%s -- docs/context/inv-63/experiment-brief.md
```

Expected output: the latest relevant commit subject followed by `docs/context/inv-63/experiment-brief.md`.

Verdict threshold: the artifact path must be present in the latest relevant commit output.

## Review verdict

INV-63 is proven when the selected harness exists, advertises the expected deterministic validation surface, accepts the minimal isolated command-only plan, and this brief is committed with the artifact path visible in git history.
