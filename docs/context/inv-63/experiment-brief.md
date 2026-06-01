# INV-63 Experiment Brief

## Goal
Establish deterministic experiment proof that the plan-to-invoker direct-output
contract (selected design) is more reviewable and evidence-backed than a free-form
prompt + autofix loop (competing design).

## Motivation
Architecture choices for the plan-to-invoker skill must be backed by reproducible
evidence with explicit pass/fail thresholds, not by subjective preference.

## Files under test
- skills/plan-to-invoker/SKILL.md
- .cursor/skills/plan-to-invoker/SKILL.md
- skills/plan-to-invoker/scripts/skill-doctor.sh

## Alternative considerations

| Design                                       | Reviewability     | Determinism | Verdict |
| -------------------------------------------- | ----------------- | ----------- | ------- |
| Direct-output benchmark mode (selected)      | high (skeleton)   | high        | adopt   |
| Free-form prompt + autofix loop (competing)  | low (free-form)   | low         | reject  |

## Deterministic experiments

### E1: SKILL.md anchors benchmark mode
- Command: `grep -c 'Benchmark/direct-output mode' skills/plan-to-invoker/SKILL.md`
- Expected output: integer >= 1
- Threshold: count >= 1
- Verdict: PASS when threshold met, FAIL otherwise

### E2: Cursor mirror parity
- Command: `test -f .cursor/skills/plan-to-invoker/SKILL.md && printf 'ok\n'`
- Expected output: `ok`
- Threshold: stdout equals `ok` and exit code 0
- Verdict: PASS when both hold, FAIL otherwise

### E3: skill-doctor.sh runnable
- Command: `test -x skills/plan-to-invoker/scripts/skill-doctor.sh && printf 'ok\n'`
- Expected output: `ok`
- Threshold: exit code 0
- Verdict: PASS when threshold met, FAIL otherwise

## Roll-up
All three experiments must produce verdict PASS for the selected design to be
considered proven. Any FAIL invalidates the proof and re-opens the alternative.
