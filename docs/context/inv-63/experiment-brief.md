# INV-63 Experiment Brief

## Scope

Establish deterministic experiment proof for INV-63 by inspecting the plan-to-invoker skill contract and its doctor script. The concrete files under test are:

- `skills/plan-to-invoker/SKILL.md`
- `.cursor/skills/plan-to-invoker/SKILL.md`
- `skills/plan-to-invoker/scripts/skill-doctor.sh`

## Selected Approach

Use a command-only deterministic proof that validates local file presence, required direct-output guidance, and the primary doctor command surface. This keeps isolated benchmark runs independent of external services, upstream workflow records, branches, pull requests, and long test suites.

## Alternative Considered

A competing design is to submit a generated Invoker workflow and treat the remote workflow result as proof. That would exercise more integration surface, but it depends on orchestration state and external workflow records, so it is less deterministic for isolated benchmark runs. The selected approach is preferred because every verdict is derived from local repository files and fixed shell commands.

## Deterministic Commands

### File Presence

Command:

```bash
for path in skills/plan-to-invoker/SKILL.md .cursor/skills/plan-to-invoker/SKILL.md skills/plan-to-invoker/scripts/skill-doctor.sh; do test -f "$path"; done
```

Expected output: no stdout and exit code 0.

Verdict: pass when all three concrete files exist; fail on any missing file.

Threshold: 3 of 3 files must be present.

### Direct-Output Contract

Command:

```bash
grep -F "Benchmark/direct-output mode" skills/plan-to-invoker/SKILL.md
grep -F "Benchmark/direct-output mode" .cursor/skills/plan-to-invoker/SKILL.md
```

Expected output: each command prints at least one matching line and exits 0.

Verdict: pass when both skill documents expose the benchmark/direct-output contract.

Threshold: 2 of 2 skill documents must match.

### Doctor Command Surface

Command:

```bash
test -x skills/plan-to-invoker/scripts/skill-doctor.sh || test -f skills/plan-to-invoker/scripts/skill-doctor.sh
grep -F "skill-doctor" skills/plan-to-invoker/scripts/skill-doctor.sh
```

Expected output: the first command has no stdout and exit code 0; the second command prints at least one matching line and exits 0.

Verdict: pass when the doctor script is present and self-identifies the doctor command surface.

Threshold: script presence must pass and at least 1 `skill-doctor` reference must be found.

## Final Verdict Threshold

INV-63 deterministic experiment proof is accepted only when all three sections pass: file presence, direct-output contract, and doctor command surface. Any failed command is a failed experiment.
