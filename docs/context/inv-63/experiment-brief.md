# INV-63 Deterministic Experiment Brief

## Goal
Establish deterministic experiment proof for INV-63 so architecture choices are evidence-backed and reviewable.

## Concrete Files Under Test
- `skills/plan-to-invoker/SKILL.md`
- `.cursor/skills/plan-to-invoker/SKILL.md`
- `skills/plan-to-invoker/scripts/skill-doctor.sh`

## Selected Approach
Use a committed experiment brief as the review artifact. The brief records deterministic local commands, expected outputs, verdicts, and acceptance thresholds for the plan-to-invoker skill path. This keeps the evidence in version control next to the implementation context and makes review independent of transient workflow records or external services.

## Competing Design Considered
A competing design is to rely on an ad hoc workflow run or external CI result as the experiment proof. That approach was rejected because isolated benchmark runs must not depend on external services, upstream workflow records, upstream branches, experiment artifacts outside the repo, pull requests, or long test suites. It also makes later reviewers reconstruct the evidence from mutable execution history instead of a deterministic committed artifact.

## Deterministic Commands
Run from the repository root.

```bash
test -f skills/plan-to-invoker/SKILL.md
test -f .cursor/skills/plan-to-invoker/SKILL.md
test -f skills/plan-to-invoker/scripts/skill-doctor.sh
test -r skills/plan-to-invoker/SKILL.md
test -r .cursor/skills/plan-to-invoker/SKILL.md
test -r skills/plan-to-invoker/scripts/skill-doctor.sh
grep -n "Benchmark/direct-output mode" skills/plan-to-invoker/SKILL.md
grep -n "skill-doctor" skills/plan-to-invoker/SKILL.md
grep -n "skill-doctor" .cursor/skills/plan-to-invoker/SKILL.md
bash skills/plan-to-invoker/scripts/skill-doctor.sh --help >/tmp/inv-63-skill-doctor-help.txt
grep -E "skill-doctor|Usage|--skip-validation|--skip-atomicity" /tmp/inv-63-skill-doctor-help.txt
```

## Expected Outputs
- All `test -f` and `test -r` commands exit with status 0.
- `grep -n "Benchmark/direct-output mode" skills/plan-to-invoker/SKILL.md` prints at least one matching line.
- Both `grep -n "skill-doctor" .../SKILL.md` checks print at least one matching line.
- `bash skills/plan-to-invoker/scripts/skill-doctor.sh --help` exits with status 0 or usage-oriented status 2 while producing help text.
- The help text includes at least one of: `skill-doctor`, `Usage`, `--skip-validation`, or `--skip-atomicity`.

## Verdicts
- PASS: all concrete files exist and are readable, direct-output guidance is present, doctor references are present in both skill documents, and the doctor script exposes deterministic command-line help.
- FAIL: any required file is missing or unreadable, direct-output guidance is absent, doctor references are absent, or the doctor script cannot produce recognizable help text.

## Thresholds
- Required file existence/readability threshold: 3 of 3 files.
- Required direct-output guidance threshold: at least 1 matching line in `skills/plan-to-invoker/SKILL.md`.
- Required doctor-reference threshold: at least 1 matching line in each skill document.
- Required help-recognition threshold: at least 1 recognized help marker in `/tmp/inv-63-skill-doctor-help.txt`.
- External dependency threshold: 0 external services, 0 upstream workflow records, 0 upstream branches, 0 pull requests, and 0 long test suites.

## Review Notes
The selected approach favors a small deterministic proof artifact over runtime history. It is intentionally scoped to the files under test and can be rerun locally without network access.
