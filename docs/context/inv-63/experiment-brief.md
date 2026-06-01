# INV-63 Deterministic Experiment Brief

## Scope

This brief establishes deterministic proof for INV-63 by inspecting the local plan-to-invoker skill surfaces under test:

- `skills/plan-to-invoker/SKILL.md`
- `.cursor/skills/plan-to-invoker/SKILL.md`
- `skills/plan-to-invoker/scripts/skill-doctor.sh`

The evidence is intentionally local-only so reviewers can reproduce it without relying on external services, upstream workflow records, upstream branches, experiment artifacts, pull requests, or long test suites.

## Selected Approach

Use a committed experiment brief as the source of reviewable proof. The brief records exact local commands, expected outputs, verdicts, and thresholds. This keeps architecture evidence close to the files under test and makes the proof auditable in normal code review.

## Competing Design

A competing design is to rely on an uncommitted local transcript or remote workflow result as the proof source. That design is rejected because it is harder to review, can disappear outside the repository, and can depend on mutable external state. The selected committed-artifact approach is deterministic and survives branch checkout, CI replay, and reviewer handoff.

## Deterministic Commands

Run these commands from the repository root.

### 1. Required Files Exist

Command:

```sh
test -f skills/plan-to-invoker/SKILL.md
test -f .cursor/skills/plan-to-invoker/SKILL.md
test -f skills/plan-to-invoker/scripts/skill-doctor.sh
printf '%s\n' 'PASS required INV-63 files exist'
```

Expected output:

```text
PASS required INV-63 files exist
```

Verdict threshold: exit code `0`.

### 2. Skill Doctor Is Executable Shell

Command:

```sh
test -s skills/plan-to-invoker/scripts/skill-doctor.sh
sed -n '1p' skills/plan-to-invoker/scripts/skill-doctor.sh | grep -E '^#!/usr/bin/env bash|^#!/bin/bash'
printf '%s\n' 'PASS skill-doctor shell entrypoint exists'
```

Expected output:

```text
PASS skill-doctor shell entrypoint exists
```

Verdict threshold: exit code `0`; the script must be non-empty and start with a Bash shebang.

### 3. Skill Instructions Preserve Direct-Output Contract

Command:

```sh
grep -F 'Benchmark/direct-output mode' skills/plan-to-invoker/SKILL.md
grep -F 'skill-doctor.sh' skills/plan-to-invoker/SKILL.md
grep -F 'Benchmark/direct-output mode' .cursor/skills/plan-to-invoker/SKILL.md
printf '%s\n' 'PASS direct-output contract is documented'
```

Expected output includes:

```text
PASS direct-output contract is documented
```

Verdict threshold: exit code `0`; all three grep checks must match.

### 4. Review Artifact Is Committed

Command:

```sh
test -f docs/context/inv-63/experiment-brief.md
git log --format=%H -n 1 -- docs/context/inv-63/experiment-brief.md | grep -E '^[0-9a-f]{40}$'
test -z "$(git status --short docs/context/inv-63/experiment-brief.md)"
printf '%s\n' 'PASS INV-63 experiment brief is committed'
```

Expected output:

```text
PASS INV-63 experiment brief is committed
```

Verdict threshold: exit code `0`; the artifact must exist, have at least one commit touching it, and have no uncommitted changes.

## Final Verdict

The selected committed-artifact approach passes INV-63 when all commands above exit `0`. Any missing file, missing direct-output contract text, invalid `skill-doctor.sh` entrypoint, absent artifact commit, or dirty artifact state fails the experiment.
