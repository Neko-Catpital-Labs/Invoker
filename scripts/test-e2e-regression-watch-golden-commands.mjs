#!/usr/bin/env node
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildCiJobDefinitions } from './e2e-regression-watch.mjs';

const BUILD_PREFIX = 'pnpm --filter @invoker/ui build && pnpm --filter @invoker/surfaces build && pnpm --filter @invoker/app build';

const GOLDEN_REQUIRED_FAST_COMMANDS = new Map([
  ['required-fast / Guardrails', `${BUILD_PREFIX} && bash scripts/test-suites/required/05-delete-all-prod-db-guard.sh && bash scripts/test-suites/required/06-large-file-guardrail.sh && bash scripts/test-suites/required/07-invalid-config-json.sh && bash scripts/test-suites/required/08-build-artifact-surfaces-guard.sh && bash scripts/test-suites/required/09-headless-cli-boots-smoke.sh && bash scripts/test-suites/required/10-dag-background-click-noop-guard.sh && bash scripts/test-suites/required/14-verify-catalog-check.sh && bash scripts/test-suites/required/15-owner-boundary-policy.sh && bash scripts/test-suites/required/50-verify-executor-routing.sh && bash scripts/test-suites/required/51-verify-scratch-execution.sh`],
  ['required-fast / Vitest Workspace', `${BUILD_PREFIX} && bash scripts/test-suites/required/10-vitest-workspace.sh`],
  ['required-fast / Submit Workflow Chain', `${BUILD_PREFIX} && bash scripts/test-suites/required/15-submit-workflow-chain.sh`],
  ['required-fast / Branch Carry Forward', `${BUILD_PREFIX} && bash scripts/test-suites/required/16-branch-carry-forward.sh`],
  ['required-fast / Merge Gate Concurrency Repro', `${BUILD_PREFIX} && bash scripts/test-suites/required/17-merge-gate-concurrency-repro.sh`],
  ['required-fast / Start Running MECE Repros', `${BUILD_PREFIX} && bash scripts/test-suites/required/18-start-running-mece-repros.sh`],
  ['required-fast / Launch Dispatch Queue Repro', `${BUILD_PREFIX} && bash scripts/test-suites/required/25-launch-dispatch-queue-handoff-repro.sh`],
  ['required-fast / Workflow Drain Queue Eval', `${BUILD_PREFIX} && bash scripts/test-suites/required/29-workflow-drain-queue-eval.sh`],
  ['required-fast / PR Babysit Harness', `${BUILD_PREFIX} && bash scripts/test-suites/required/28-pr-babysit-harness.sh`],
  ['required-fast / PR Authoring Guardrails', `${BUILD_PREFIX} && bash scripts/test-suites/required/11-pr-authoring-guardrails.sh`],
  ['required-fast / Mergify Admin Requeue', `${BUILD_PREFIX} && bash scripts/test-suites/required/12-mergify-admin-requeue.sh`],
  ['required-fast / Reset Rulebook Repro', `${BUILD_PREFIX} && bash scripts/test-suites/required/26-reset-rulebook-proof.sh`],
]);

const definitions = buildCiJobDefinitions();

function requiredFastNames(defs) {
  return [...defs.keys()].filter((name) => name.startsWith('required-fast / ')).sort();
}

describe('buildCiJobDefinitions golden verify commands (real .github/workflows/ci.yml)', () => {
  it('pins the exact verify command for required-fast / Vitest Workspace', () => {
    assert.equal(
      definitions.get('required-fast / Vitest Workspace')?.verifyCommand,
      GOLDEN_REQUIRED_FAST_COMMANDS.get('required-fast / Vitest Workspace'),
    );
  });

  it('pins the exact verify command for required-fast / Guardrails', () => {
    assert.equal(
      definitions.get('required-fast / Guardrails')?.verifyCommand,
      GOLDEN_REQUIRED_FAST_COMMANDS.get('required-fast / Guardrails'),
    );
  });

  it('pins the exact verify command for every required-fast job', () => {
    for (const [jobName, expected] of GOLDEN_REQUIRED_FAST_COMMANDS) {
      const definition = definitions.get(jobName);
      assert.ok(definition, `missing job definition for ${jobName}`);
      assert.equal(definition.verifyCommand, expected, `verify command drifted for ${jobName}`);
    }
  });

  it('covers exactly the required-fast jobs declared in ci.yml', () => {
    assert.deepEqual(
      requiredFastNames(definitions),
      [...GOLDEN_REQUIRED_FAST_COMMANDS.keys()].sort(),
    );
  });
});
