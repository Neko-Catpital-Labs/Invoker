# INV-63 Experiment Brief

## Purpose

This workflow must carry the INV-63 experiment evidence as an in-repo artifact. Later implementation must consume deterministic local criteria instead of relying on upstream workflow state, external artifact paths, or informal alternatives.

## Experiment Conclusion

INV-63 should update these local files:

- `skills/plan-to-invoker/SKILL.md`
- `.cursor/skills/plan-to-invoker/SKILL.md`
- `skills/plan-to-invoker/scripts/skill-doctor.sh`

The `.cursor/skills/plan-to-invoker` path is a symlink to `../../skills/plan-to-invoker`, so implementation changes to `skills/plan-to-invoker/SKILL.md` are also expected to be visible through `.cursor/skills/plan-to-invoker/SKILL.md`.

## Verdicts

### Supported

- Materialize this local experiment brief before implementation begins.
- Treat `skills/plan-to-invoker/SKILL.md`, `.cursor/skills/plan-to-invoker/SKILL.md`, and `skills/plan-to-invoker/scripts/skill-doctor.sh` as the explicit implementation surface for INV-63.
- Use deterministic verification commands that run inside this repository and do not require upstream experiment artifacts.
- Preserve existing fixture behavior while adding any INV-63 behavior, so targeted verification can distinguish expected implementation changes from regressions.

### Rejected

- Do not depend on an upstream workflow branch, commit, artifact path, or external experiment output.
- Do not use informal acceptance criteria that cannot be checked by a deterministic command.
- Do not change runtime architecture as part of this evidence handoff.
- Do not commit implementation changes in the same slice as this experiment brief.

### Deferred

- Remove this temporary experiment artifact after INV-63 implementation and focused verification are complete.
- Broaden verification beyond the targeted commands only if implementation changes affect shared behavior outside the plan-to-invoker skill surface.
- Add end-to-end workflow coverage later if INV-63 expands beyond skill documentation and `skill-doctor.sh` behavior.

## Deterministic Verification Criteria

### Command: Help Contract

```bash
bash skills/plan-to-invoker/scripts/skill-doctor.sh --help
```

Expected output:

- Prints a usage header for `skill-doctor.sh`.
- Lists `--help`.
- Lists `--skip-assumptions`.
- Lists `--skip-atomicity`.
- Lists `--skip-validation`.
- Lists `--source-file FILE`.
- Lists `--coverage-map FILE`.
- Lists `--stack-manifest FILE`.
- Lists `--verbose`.
- Lists `--warn-delegation`.
- Includes exit code documentation for `0 = all checks passed` and `1 = one or more checks failed`.

Pass threshold:

- Command exits with status `0`.
- All expected output items above are present.
- Output is deterministic enough for direct text matching of option names and exit code documentation.

Fail threshold:

- Command exits non-zero.
- Any expected option or exit code line is missing.
- Help output requires repository state outside this workflow.

### Command: Fixture Regression Contract

```bash
bash skills/plan-to-invoker/scripts/test-fixtures.sh
```

Expected output:

- Runs the positive fixture suite.
- Reports `PASS` for every positive fixture.
- Runs the negative fixture suite.
- Reports `PASS` for every negative fixture, meaning each invalid fixture was rejected as expected.
- Runs the specific error type suite.
- Ends with a summary that reports `Fixture tests: 50/50 passed`.
- Prints `All fixture tests passed`.

Pass threshold:

- Command exits with status `0`.
- Final summary contains `Fixture tests: 50/50 passed` and `All fixture tests passed`.
- No unexpected fixture failure is reported.

Fail threshold:

- Command exits non-zero.
- Final summary reports any failed test.
- Positive fixtures fail or negative fixtures pass unexpectedly.
- The command depends on upstream workflow artifacts.

## Implementation Gate

Implementation may begin only after this file exists and is committed by itself. The implementation slice must explicitly consume the Supported, Rejected, and Deferred verdicts above when updating the plan-to-invoker skill and `skill-doctor.sh`.
