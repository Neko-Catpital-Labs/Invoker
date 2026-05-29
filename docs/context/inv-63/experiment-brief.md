# INV-63 Experiment Brief

## Purpose

Define deterministic experiment criteria for INV-63 before changing `skills/plan-to-invoker/SKILL.md`, `.cursor/skills/plan-to-invoker/SKILL.md`, or `skills/plan-to-invoker/scripts/skill-doctor.sh`.

## Supported Verdict

Implement tasks that depend on experiments must explicitly reference and consume `docs/context/inv-63/experiment-brief.md`.

The implementation is supported only if it preserves these measurable properties:

- Experiment evidence is represented as a committed artifact before implementation changes.
- Implementation guidance names `docs/context/inv-63/experiment-brief.md` as the source artifact for INV-63 experiment criteria.
- Deterministic checks can prove the artifact exists and contains the selected verdict, rejected alternatives, deferred work, expected outputs, and pass/fail thresholds.
- Runtime behavior is unchanged by this experiment-design slice.

## Rejected Verdict

Moving directly to implementation without a committed experiment artifact is rejected.

Informal evaluation without deterministic checks is rejected because it cannot prove that the implementation consumed the design tradeoffs recorded for INV-63.

## Deferred Verdict

Unrelated plan-to-invoker policy rewrites are deferred.

Changes to `skills/plan-to-invoker/SKILL.md`, `.cursor/skills/plan-to-invoker/SKILL.md`, and `skills/plan-to-invoker/scripts/skill-doctor.sh` are deferred to the implementation task that consumes this artifact.

## Deterministic Commands

Run these commands from the repository root:

```sh
test -f docs/context/inv-63/experiment-brief.md
rg -n "Supported|Rejected|Deferred|Pass/fail|Expected output|docs/context/inv-63/experiment-brief.md" docs/context/inv-63/experiment-brief.md
git log -1 --stat
```

## Expected Output

`test -f docs/context/inv-63/experiment-brief.md` exits with status 0 and prints no output.

`rg -n "Supported|Rejected|Deferred|Pass/fail|Expected output|docs/context/inv-63/experiment-brief.md" docs/context/inv-63/experiment-brief.md` exits with status 0 and prints matching lines for the supported, rejected, deferred, pass/fail, expected output, and artifact-reference criteria.

`git log -1 --stat` exits with status 0 and shows `docs/context/inv-63/experiment-brief.md` in the latest commit stat.

## Pass/fail Thresholds

Pass:

- The artifact exists at `docs/context/inv-63/experiment-brief.md`.
- The artifact contains the terms `Supported`, `Rejected`, `Deferred`, `Pass/fail`, and `Expected output`.
- The artifact explicitly names `docs/context/inv-63/experiment-brief.md` as the document that experiment-dependent implementation tasks must reference and consume.
- The latest commit includes `docs/context/inv-63/experiment-brief.md`.

Fail:

- The artifact is missing or located at a different path.
- Any required verdict or deterministic-check section is absent.
- The supported design does not require implementation tasks to consume `docs/context/inv-63/experiment-brief.md`.
- The latest commit does not include `docs/context/inv-63/experiment-brief.md`.
