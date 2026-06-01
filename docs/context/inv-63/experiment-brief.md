# INV-63 Experiment Brief

## Files under test
- `skills/plan-to-invoker/SKILL.md`
- `.cursor/skills/plan-to-invoker/SKILL.md`
- `skills/plan-to-invoker/scripts/skill-doctor.sh`

## Selected design: consolidated `skill-doctor.sh`
Run all validation checks in one command and rely on its exit code.

### Deterministic command
```
bash skills/plan-to-invoker/scripts/skill-doctor.sh <plan-file>
```

### Expected output
JSON summary with per-check pass/fail status. Exit code 0 on full pass.

### Verdict thresholds
- PASS: exit code 0 AND zero "fail" entries in the JSON summary.
- FAIL: exit code 1 OR any sub-check reports failure.
- INVALID: exit code 2 (usage error) — re-run with corrected arguments.

## Alternative design: per-script fallback
Invoke each sub-check individually for finer-grained isolation.

### Deterministic commands
```
bash skills/plan-to-invoker/scripts/extract-assumptions.sh <plan-file>
bash skills/plan-to-invoker/scripts/validate-plan.sh <plan-file>
bash skills/plan-to-invoker/scripts/lint-task-atomicity.sh <plan-file>
bash skills/plan-to-invoker/scripts/parse-results.sh < /tmp/invoker-verify.txt
```

### Expected output
Each script returns its own pass/fail line and exit code.

### Verdict thresholds
- PASS: every sub-command exits 0.
- FAIL: any sub-command exits non-zero.
- INVALID: missing input file (exit 2 from one of the scripts).

## Comparison and selection
| Criterion | Consolidated (selected) | Per-script (alternative) |
|-----------|-------------------------|--------------------------|
| Single pass/fail oracle | Yes | No (must aggregate) |
| Debug isolation | Coarse | Fine |
| Drift risk between editor mirrors | Surfaced via SKILL.md compare | Surfaced only if compared explicitly |
| Threshold complexity | One exit code + JSON | Four exit codes |

Selected: consolidated `skill-doctor.sh` for review-time simplicity, with per-script fallback retained for debugging.

## Reproducibility checklist
- [ ] All three files under test exist on disk.
- [ ] `skill-doctor.sh` exits 0 on the candidate plan.
- [ ] JSON summary contains zero failures.
- [ ] Per-script fallback agrees with the consolidated verdict when re-run.
