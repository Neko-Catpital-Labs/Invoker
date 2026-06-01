# INV-63 Deterministic Experiment Brief

## Goal

Establish deterministic experiment proof for INV-63 so architecture choices are evidence-backed and reviewable.

## Concrete Files Under Test

- `skills/plan-to-invoker/SKILL.md`
- `.cursor/skills/plan-to-invoker/SKILL.md`
- `skills/plan-to-invoker/scripts/skill-doctor.sh`

## Selected Approach

Use the repository-owned `skill-doctor.sh` validation surface as the deterministic proof harness for plan-to-invoker behavior. This keeps the proof close to the production skill contract and exercises the same script reviewers and maintainers can run locally.

## Alternative Considered

A competing design is to rely on ad hoc grep checks over `SKILL.md` files and the doctor script. That approach is faster to author, but it proves only that specific strings exist. It does not demonstrate that the integrated validation surface still accepts a representative plan or that the plan contract remains executable.

Verdict: prefer the repository-owned doctor harness, with grep checks only as a supporting sanity layer.

## Deterministic Commands

Run from the repository root.

```sh
test -f skills/plan-to-invoker/SKILL.md
test -f .cursor/skills/plan-to-invoker/SKILL.md
test -f skills/plan-to-invoker/scripts/skill-doctor.sh
```

Expected output: no stdout and exit code `0` for each command.

Verdict threshold: all three file-existence checks must pass.

```sh
tmp_plan="$(mktemp)"
cat > "$tmp_plan" <<'PLAN'
name: "INV-63 smoke plan"
onFinish: none
mergeMode: manual
repoUrl: "https://github.com/Neko-Catpital-Labs/Invoker.git"
tasks:
  - id: "inv-63-smoke"
    description: "Deterministic local smoke check for INV-63."
    command: "printf '%s\n' 'INV-63 deterministic smoke passed'"
    dependencies: []
PLAN
bash skills/plan-to-invoker/scripts/skill-doctor.sh "$tmp_plan"
rm -f "$tmp_plan"
```

Expected output: JSON summary from `skill-doctor.sh` indicating successful checks, and exit code `0`.

Verdict threshold: the command must exit `0`; any non-zero exit is a failed experiment.

```sh
grep -F "Benchmark/direct-output mode" skills/plan-to-invoker/SKILL.md
grep -F "Benchmark/direct-output mode" .cursor/skills/plan-to-invoker/SKILL.md
grep -F "skill-doctor" skills/plan-to-invoker/scripts/skill-doctor.sh
```

Expected output: at least one matching line for each grep command.

Verdict threshold: all three grep commands must exit `0`. These checks are supporting evidence only and do not replace the doctor harness.

## Reviewable Verdict

The selected architecture is accepted when:

- The concrete files under test exist.
- A representative command-only manual-merge plan passes `skill-doctor.sh`.
- The skill documentation and doctor script expose the expected benchmark/direct-output and validation concepts.

The selected architecture is rejected if any command exits non-zero.
