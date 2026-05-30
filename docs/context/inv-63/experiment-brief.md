# INV-63 Deterministic Experiment Brief

## Goal and Motivation

INV-63 establishes deterministic proof for the plan-to-invoker validation strategy. The goal is to make the architecture choice evidence-backed and reviewable before follow-on implementation work depends on it.

The motivation is to replace broad or prose-only confidence with commands that reviewers can run from the repository root. The proof should show that the selected validation surface is local, focused, repeatable, and tied to the skill files that define plan-to-invoker behavior.

## Files under test

- `skills/plan-to-invoker/SKILL.md`
- `.cursor/skills/plan-to-invoker/SKILL.md`
- `skills/plan-to-invoker/scripts/skill-doctor.sh`

## Selected Approach

Use a deterministic-command brief that documents the exact local checks reviewers should run against the plan-to-invoker skill documents and `skill-doctor.sh`.

This approach is selected because the inspected files already define a deterministic validation contract:

- Both skill docs describe `bash skills/plan-to-invoker/scripts/skill-doctor.sh <plan-file>` as the primary validation surface.
- The skill docs define exact `skill-doctor.sh` exit code meanings: `0` for all checks passed, `1` for check failure, and `2` for usage or argument errors.
- `skill-doctor.sh` implements local argument validation, emits a JSON summary when checks run, and has usage behavior that can be checked without network access or an external service.

The experiment therefore measures the local command contract and file alignment directly instead of relying on upstream workflow records, pull requests, or long test suites.

## Competing Designs

### Prose-only rationale

A prose-only rationale would explain why `skill-doctor.sh` is the intended validation surface without requiring deterministic commands. This is insufficient because reviewers could not distinguish a true inspected contract from an unsupported architectural assertion. It also would not set concrete thresholds for exit codes, required output fragments, or file references.

### Broad full-suite testing

Running a broad suite such as `pnpm run test:all` would provide wider regression confidence, but it is not the right proof for this slice. INV-63 is a docs-layer experiment artifact, not a runtime behavior change. A full suite is slower, may depend on unrelated repository state, and does not directly prove that the selected plan-to-invoker validation strategy is documented in the files under test.

## Verdict on Approach

The deterministic-command brief is preferred because it is narrow enough to review, tied to the selected architecture surface, and reproducible from a clean checkout without external services. It also gives follow-on tasks concrete pass/fail thresholds they can consume without inferring intent from chat context.

## Deterministic Command Matrix

All commands are run from the repository root. They must not use network access, external services, upstream workflow records, upstream branches, pull requests, or experiment artifacts outside this file.

| Check | Command | Expected output or status | Pass/fail verdict | Threshold |
| --- | --- | --- | --- | --- |
| Skill docs are aligned | `cmp -s skills/plan-to-invoker/SKILL.md .cursor/skills/plan-to-invoker/SKILL.md` | Exit status `0` | Pass when exit status is exactly `0` | The two skill docs must be byte-identical so the canonical and cursor skill surfaces do not diverge. |
| Required files exist | `test -f skills/plan-to-invoker/SKILL.md && test -f .cursor/skills/plan-to-invoker/SKILL.md && test -f skills/plan-to-invoker/scripts/skill-doctor.sh` | Exit status `0` | Pass when exit status is exactly `0` | All three files under test must exist at the exact paths listed above. |
| Primary command is documented | `rg -n 'bash skills/plan-to-invoker/scripts/skill-doctor.sh <plan-file>' skills/plan-to-invoker/SKILL.md .cursor/skills/plan-to-invoker/SKILL.md` | Output contains both `skills/plan-to-invoker/SKILL.md` and `.cursor/skills/plan-to-invoker/SKILL.md` | Pass when `rg` exits `0` and both file paths appear in output | Both skill docs must name the same primary validation command. |
| Exit code contract is documented | `rg -n '0 = all checks pass|1 = one or more failures|2 = usage error' skills/plan-to-invoker/SKILL.md .cursor/skills/plan-to-invoker/SKILL.md` | Output contains matches for `0`, `1`, and `2` in both skill docs | Pass when `rg` exits `0` and each expected exit-code fragment appears for both docs | The documented status contract must cover success, validation failure, and usage error. |
| Script exposes help locally | `bash skills/plan-to-invoker/scripts/skill-doctor.sh --help` | Exit status `0`; output contains `Usage: bash skill-doctor.sh [OPTIONS] <plan-file>` | Pass when exit status is exactly `0` and the usage fragment appears | Help must be available without a plan file, network, or generated artifacts. |
| Script rejects a missing plan deterministically | `bash skills/plan-to-invoker/scripts/skill-doctor.sh /tmp/inv-63-missing-plan.yaml` | Exit status `2`; stderr contains `ERROR: Plan file not found: /tmp/inv-63-missing-plan.yaml` | Pass when exit status is exactly `2` and the exact error fragment appears | Missing input must fail as usage or argument error, not as a runtime or external-service failure. |
| Script rejects an omitted plan deterministically | `bash skills/plan-to-invoker/scripts/skill-doctor.sh` | Exit status `2`; stderr contains `ERROR: Plan file argument required` | Pass when exit status is exactly `2` and the exact error fragment appears | Omitted input must fail before invoking validators or external behavior. |
| Script emits JSON summary for check runs | `rg -n 'planFile|allPassed|firstFailedStep|checks' skills/plan-to-invoker/scripts/skill-doctor.sh` | Output contains all four JSON summary keys | Pass when `rg` exits `0` and all required keys appear | The orchestrator must retain a machine-readable summary shape for reviewer inspection. |
| No external-service dependency in proof artifact | `rg -n 'external services|upstream workflow records|upstream branches|pull requests|long test suites' docs/context/inv-63/experiment-brief.md` | Output contains all listed forbidden-dependency phrases as exclusions | Pass when `rg` exits `0` and all phrases appear only as exclusions or constraints | The brief must explicitly exclude network, upstream, PR, and broad-suite requirements. |

## Review Thresholds

- The artifact path must be exactly `docs/context/inv-63/experiment-brief.md`.
- The only committed file change for this slice must be `docs/context/inv-63/experiment-brief.md`.
- Commands in the matrix must run from the repository root.
- Commands must be deterministic local checks: shell builtins, `cmp`, `test`, `rg`, and `bash` only.
- No command may require network access, external services, upstream workflow records, upstream branches, pull requests, generated experiment outputs, or long test suites.
- Exit status checks must use exact expected values: `0` for successful local proof checks and `2` for `skill-doctor.sh` usage or argument errors.
- Required output checks must name exact fragments, including the three files under test and `Usage: bash skill-doctor.sh [OPTIONS] <plan-file>`.
- Git evidence must show the committed artifact: `git log -1 --pretty=%s` must mention `INV-63` or `inv-63`, and `git show --stat --oneline HEAD` must include `docs/context/inv-63/experiment-brief.md`.

## Final Verdict

INV-63 should proceed with the deterministic-command brief as the evidence strategy. It is the smallest proof that directly validates the selected plan-to-invoker architecture surface, gives reviewers concrete thresholds, and avoids unrelated runtime, service, or workflow dependencies.
