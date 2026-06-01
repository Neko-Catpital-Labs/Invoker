# INV-63 Experiment Brief

## Goal
Establish deterministic experiment proof for INV-63 so architecture choices are evidence-backed and reviewable.

## Files Under Test
- 
- 
- 

## Selected Approach
Use  as the deterministic proof harness because it is the documented aggregate validation surface for plan-to-invoker behavior. The harness centralizes schema validation, assumption extraction, verify-plan generation, task atomicity linting, and parse-results validation behind one stable pass/fail command.

## Competing Design
A competing design is to validate behavior with ad hoc  checks against the two  files and the shell script. That approach is useful for static coverage but is rejected as the final proof because text presence alone does not verify executable behavior, exit-code contracts, or composed validation ordering.

## Deterministic Commands
| Command | Expected output | Verdict | Threshold |
| --- | --- | --- | --- |
|  | exit code  | Required file surface exists | Must pass with exit code  |
| bash skills/plan-to-invoker/scripts/skill-doctor.sh <plan-file>
bash skills/plan-to-invoker/scripts/skill-doctor.sh <plan-file> | at least one matching line | Primary validation command is documented | Match count must be  |
| **Exit codes:** 0 = all checks pass, 1 = one or more failures, 2 = usage error | at least one matching line | Pass/fail contract is documented | Match count must be  |
| - Do not self-run `skill-doctor`, validation loops, or submit commands. Validation happens outside this direct-output mode.
**Bugfix repro:** For bug/regression plans, a shared `bash scripts/repro-<slug>.sh` (or the same `command:` before and after) is **strongly recommended**; **`skill-doctor` does not require it.** If the fix invalidates the original repro, use another explicit verification task. See `references/task-patterns.md` § *Bugfix repro*.
bash skills/plan-to-invoker/scripts/skill-doctor.sh <plan-file>
When converting from an existing conversation, transcript, or plan document, always pass that original artifact as `--source-file <source>`. If the source already contains a concrete Invoker YAML plan, `skill-doctor` rejects generated plans that drop or replace its task IDs, including generic smoke plans.
If `skill-doctor.sh` fails, run individual checks to isolate the problem:
  Optional: append `--warn-delegation` to print additional advisory hints. For authored stacks, append `--stack-manifest <file>` so non-terminal workflows may end with focused verification while the highest-order workflow still requires `pnpm run test:all`. Atomicity lint always runs `--strict-delegation` inside `skill-doctor` and, for implementation plans (`onFinish != none`), hard-fails missing/invalid `Layer:` and `Feature state:` metadata, missing required review-compression/rationale headings in `description` on any task (`Review claim`, `Safety invariant`, `Slice rationale`, `Architectural effect`, `Goal`, `Motivation`, `Alternative considerations`/`Alternatives`, `Implementation details`/`Implementation`), missing required rationale headings in `prompt` for prompt tasks, prompt tasks without `Files:`/`Change types:`/`Acceptance criteria:` description blocks, prompts missing zero-context execution framing, prompts missing deterministic pass/fail expectations, invalid cross-layer dependency direction without `Layer exception: allowed`, and missing experiment-artifact handoff/cleanup contract when experiment tasks are present.
- Implementation-plan full-suite gate: standalone implementation plans and terminal stack workflows must end with `pnpm run test:all` from the repo root and depend on every earlier task. Non-terminal stack workflows should end with focused verification; validate them with `skill-doctor --stack-manifest <file>` so the stack position is explicit.
bash skills/plan-to-invoker/scripts/skill-doctor.sh <plan-file> | at least one matching line | Cursor-facing skill docs reference the harness | Match count must be  |
|     "extract-assumptions" \
    bash "$SCRIPT_DIR/extract-assumptions.sh" "$ASSUMPTIONS_INPUT"
  if [[ -f "$TEMP_DIR/extract-assumptions.out" ]]; then
    cp "$TEMP_DIR/extract-assumptions.out" "$ASSUMPTIONS_FILE"
    "validate-plan" \
    bash "$SCRIPT_DIR/validate-plan.sh" "$PLAN_FILE"
      "lint-task-atomicity" \
      bash "$SCRIPT_DIR/lint-task-atomicity.sh" "${atomicity_args[@]}" "$PLAN_FILE"
      "lint-task-atomicity" \
      bash "$SCRIPT_DIR/lint-task-atomicity.sh" "${atomicity_args[@]}" "$PLAN_FILE"
# Check 5: Validate parse-results.sh with mock execution output
  "parse-results" \
  "Validate parse-results.sh can parse execution output" \
  bash -c "echo '$MOCK_RESULTS' | bash '$SCRIPT_DIR/parse-results.sh' | jq -e '.summary.total >= 0'" | at least three matching validation phases | Harness composes multiple deterministic checks | Match count must be  |

## Acceptance Thresholds
- All commands above must exit with status .
- Every file under test must be referenced explicitly in this brief.
- The selected approach must be compared against at least one competing design.
- The committed artifact must be present in commit a055cacdace75c86670b569b4ec9eb67589924a1
Author: Edbert Chan <edbert.chan@yahoo.com>
Date:   Sat May 30 20:27:36 2026 +0800

    Add standalone CLI release packaging (#990)
    
    ## Summary
    
    Adds the v0.0.3 standalone CLI and release packaging path:
    
    - publishes standalone CLI and desktop npm launcher packages
    - builds and archives standalone CLI binaries for release assets
    - embeds the standalone CLI helper in desktop packages
    - documents npm installs, direct release downloads, checksums, run
    modes, and current `poolId` plan routing in the README
    - skips release downloads from npm launcher postinstall scripts when
    running inside the monorepo workspace
    
    ## Test Plan
    
    - [x] `pnpm --filter @invoker/app test --
    src/__tests__/cli-helper.test.ts`
    - [x] `pnpm --filter @invoker/cli test`
    
    ## Revert Plan
    
    - Safe to revert? Yes
    - Revert command: `git revert <merge-commit-sha>`
    - Post-revert steps: Rebuild release artifacts from the reverted branch
    before publishing another release.
    - Data migration? No

.github/workflows/release.yml
.gitignore
README.md
package.json
packages/app/package.json
packages/app/src/__tests__/cli-helper.test.ts
packages/app/src/api-server.ts
packages/app/src/cli-helper.ts
packages/app/src/ipc-read-handlers.ts
packages/cli/package.json
packages/cli/src/__tests__/cli.test.ts
packages/cli/src/index.ts
packages/contracts/package.json
packages/contracts/src/ipc-channels.ts
packages/core/package.json
packages/data-store/package.json
packages/data-store/src/adapter.ts
packages/data-store/src/sqlite-adapter.ts
packages/execution-engine/package.json
packages/graph/package.json
packages/npm-cli/README.md
packages/npm-cli/bin/invoker-cli.js
packages/npm-cli/package.json
packages/npm-cli/scripts/install.js
packages/npm-cli/vendor/.gitkeep
packages/npm-ui/README.md
packages/npm-ui/bin/invoker-ui.js
packages/npm-ui/package.json
packages/npm-ui/scripts/install.js
packages/npm-ui/vendor/.gitkeep
packages/persistence/package.json
packages/protocol/package.json
packages/runtime-adapters/package.json
packages/runtime-domain/package.json
packages/runtime-service/package.json
packages/shell/package.json
packages/surfaces/package.json
packages/svc-api/package.json
packages/test-kit/package.json
packages/transport/package.json
packages/ui/package.json
packages/web-app/package.json
packages/workflow-core/package.json
packages/workflow-core/tsconfig.json
packages/workflow-graph/package.json
pnpm-lock.yaml
scripts/archive-cli-binary.sh
scripts/build-cli-standalone.mjs
scripts/package-cli-archives.sh
scripts/package-desktop.sh
scripts/release-sha256.sh for the commit that adds this brief.

## Review Verdict
The selected harness-based proof is accepted for INV-63 because it ties the architectural choice to executable, deterministic evidence instead of relying only on static text inspection.
