# INV-63 Deterministic Experiment Brief

## Goal
Establish deterministic experiment proof for INV-63 so architecture choices are evidence-backed and reviewable.

## Files Under Test
- `skills/plan-to-invoker/SKILL.md`
- `.cursor/skills/plan-to-invoker/SKILL.md`
- `skills/plan-to-invoker/scripts/skill-doctor.sh`

## Selected Approach
Use repository-local deterministic evidence: file existence checks, line-count checks, and local command contracts documented from the files under test. This approach is selected because it does not depend on external services, upstream workflow records, upstream branches, local session files, pull requests, or long test suites.

## Competing Design
A competing design would prove INV-63 by querying prior workflow runs, PR state, or external CI output. That design is rejected for this experiment because isolated benchmark runs must be reproducible without external dependencies and because remote state can change independently of the repository contents under review.

## Deterministic Commands

### Source file presence
Command:
```sh
test -f skills/plan-to-invoker/SKILL.md
test -f .cursor/skills/plan-to-invoker/SKILL.md
test -f skills/plan-to-invoker/scripts/skill-doctor.sh
```
Expected output: no stdout and exit code 0.
Threshold: all three files must exist.
Verdict: pass when every `test -f` command exits 0; fail otherwise.

### Stable inspection surface
Command:
```sh
wc -l skills/plan-to-invoker/SKILL.md .cursor/skills/plan-to-invoker/SKILL.md skills/plan-to-invoker/scripts/skill-doctor.sh
```
Expected output: four `wc -l` rows, one per file plus `total`.
Threshold: each file row must report a line count greater than 0.
Verdict: pass when all files are non-empty; fail if any line count is 0 or missing.

### Doctor command contract
Command:
```sh
grep -n "skill-doctor.sh <plan-file>" skills/plan-to-invoker/SKILL.md .cursor/skills/plan-to-invoker/SKILL.md
grep -n "Exit codes" skills/plan-to-invoker/SKILL.md .cursor/skills/plan-to-invoker/SKILL.md
test -x skills/plan-to-invoker/scripts/skill-doctor.sh
```
Expected output: matching lines for the documented doctor invocation and exit-code contract, followed by no stdout from `test -x`.
Threshold: at least one invocation match and one exit-code match must be present in both skill documents; the script must be executable.
Verdict: pass when documentation and executable script agree on a local deterministic validation surface.

## Reviewable Evidence Standard
The experiment is sufficient when the commands above can be run from the repository root and produce deterministic pass/fail results tied only to the files under test. Architecture review should cite this artifact and the concrete file paths above.
