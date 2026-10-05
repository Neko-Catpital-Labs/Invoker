#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

unwired=()
while IFS= read -r test_file; do
  base="$(basename "$test_file")"
  if grep -q -F "$base" "$0"; then
    continue
  fi
  if grep -q -F "$base" package.json; then
    continue
  fi
  unwired+=("$test_file")
done < <(find scripts -maxdepth 1 \( -name '*.test.mjs' -o -name 'test-*.mjs' \) | LC_ALL=C sort)
if [ "${#unwired[@]}" -gt 0 ]; then
  printf 'unwired root test (add it here or to package.json scripts): %s\n' "${unwired[@]}" >&2
  exit 1
fi

if [ "${1:-}" = "--check-wiring-only" ]; then
  exit 0
fi

node --test \
  scripts/cleanup-orphaned-automation-chrome.test.mjs \
  scripts/e2e-regression-watch.test.mjs \
  scripts/electron-unzip-fallback.test.mjs \
  scripts/error-fingerprint.test.mjs \
  scripts/invoker-command-concurrency-watchdog.test.mjs \
  scripts/repair-filing-ledger.test.mjs \
  scripts/retry-ledger.test.mjs \
  scripts/evals/db-maintenance-starvation.test.mjs

node scripts/test-bazel-overlay.mjs
node scripts/test-bundled-skill-categories.mjs
node scripts/test-create-pr-visual-proof.mjs
node scripts/test-discord-live-e2e.mjs
node scripts/test-repro-disposition.mjs
node scripts/test-bump-release-version.mjs
node scripts/test-bump-version-changelog.mjs
node scripts/test-check-silent-catches.mjs
node scripts/test-ci-workflow-e2e-proof-tmp-cleanup.mjs
node scripts/test-cli-headless-parity.mjs
node scripts/test-extract-changelog-section.mjs
node scripts/test-flaky-test-registry.mjs
node scripts/test-gh-actions-concurrency-exhausted.mjs
node scripts/test-guarded-behavior-approval.mjs
node scripts/test-jailbreak-admin-bypass-land.mjs
node scripts/test-land-stack.mjs
node scripts/test-migrate-default-execution-harness.mjs
node scripts/test-pr-body-policy-skill-docs-mix.mjs
node scripts/test-pr-body-validator.mjs
node scripts/test-pr-diff-atomicity-multiline-assertion.mjs
node scripts/test-worker-session-mine-efficiency.mjs
node scripts/worker-session-mine-resolve.selftest.mjs
node scripts/worker-session-mine-rollup.selftest.mjs
node scripts/worker-session-mine.selftest.mjs

python3 scripts/test-analyze-json-log.py
python3 scripts/test-codex-session-audit.py
python3 scripts/test-codex-session-insight-miner.py
python3 scripts/test-session-token-rollup.py

bash scripts/test-cron-pr-auto-label-matching.sh
bash scripts/test-cron-prune-stale-workdirs.sh
bash scripts/test-cron-session-token-push.sh
bash scripts/test-e2e-common-helper.sh
bash scripts/test-plan-effectiveness-gate.sh
bash scripts/test-remote-ci-verify-env-quoting.sh
bash scripts/test-workspace-test-flaky-wiring.sh
bash scripts/test-linear-ticket-intake.sh

bash scripts/repro/repro-coderabbit-pr3242-close-app-exit.sh
bash scripts/repro/repro-pending-task-did-not-run-wf-1781538160448-3-final-regression.sh
bash scripts/repro/prove-worker-session-mine-skill-absent.sh
bash scripts/repro/repro-stale-merge-terminal-workspace-path.sh
bash scripts/repro/repro-pr-body-stale-base-sha.sh
bash scripts/repro/repro-stale-mirror-clone-unreachable-dependency-commit.sh
bash scripts/repro/repro-pr-body-squash-merge-undershoot.sh
bash scripts/repro/repro-coderabbit-pr5800-missing-esbuild-diagnostic.sh
bash scripts/repro/repro-pr-body-base-fetch-cached-fallback.sh
bash scripts/repro/repro-validator-fenced-and-indented-headings.sh
bash scripts/repro/repro-admin-bypass-safe-push-unreachable-commit.sh
bash scripts/repro/repro-coderabbit-pr5251-mergify-admin-requeue-yaml-alias.sh
bash scripts/repro/repro-coderabbit-pr7488-event-loop-lag-single-sample.sh
bash scripts/repro/repro-trusts-agent-reported-pr-body.sh
bash scripts/repro/repro-merge-gate-provisioning-not-surfaced.sh
bash scripts/repro/repro-worker-session-mine-refs-remain.sh
bash scripts/repro/repro-pending-task-did-not-run-__merge__wf-1782192500131-3.sh
bash scripts/repro/repro-babysit-conflict-repair-invalid-stop.sh
bash scripts/repro/repro-babysit-headless-queued-comment.sh
bash scripts/repro/repro-babysit-human-review-thread-block.sh
bash scripts/repro/repro-babysit-merged-pr-terminal.sh
bash scripts/repro/repro-babysit-no-current-bottom-comment.sh
bash scripts/repro/repro-babysit-outdated-bot-thread.sh
bash scripts/repro/repro-babysit-queue-only-missing-requeues.sh
bash scripts/repro/repro-babysit-queue-repair-invalid-stop.sh
bash scripts/repro/repro-babysit-retarget-stale-bottom-base.sh
bash scripts/repro/repro-babysit-stack-human-blocker-suppresses-repairs.sh
bash scripts/repro/repro-babysit-targeted-scan-light.sh
bash scripts/repro/repro-babysit-upper-stack-needs-acceptance-comment.sh
bash scripts/repro/repro-coderabbit-pr2634-canonical-tool-node.sh
bash scripts/repro/repro-coderabbit-pr2634-default-preset-error.sh
bash scripts/repro/repro-coderabbit-pr2897-node-lookup-errexit.sh
bash scripts/repro/repro-coderabbit-pr4773-fractional-retries.sh
bash scripts/repro/repro-coderabbit-pr4815-db-dir-contract.sh
bash scripts/repro/repro-coderabbit-pr5197-registry-parent-delete.sh
bash scripts/repro/repro-coderabbit-pr5197-registry-read-race.sh
bash scripts/repro/repro-coderabbit-pr5800-leg1-tick-error-assertion.sh
bash scripts/repro/repro-deploy-self-kill-aborts-restart.sh
node scripts/repro/repro-e2e-watch-same-job-distinct-failures.mjs
bash scripts/repro/repro-git-push-hangs-no-timeout.sh
node scripts/repro/repro-headless-query-stdout-truncation.mjs
bash scripts/repro/repro-heartbeat-timeout-after-close-finalize-hang.sh
bash scripts/repro/repro-merge-queue-close-capacity.sh
python3 scripts/repro/repro-mergify-admin-requeue-repair-in-flight-stale-failure.py
bash scripts/repro/repro-normalize-blocked-dirty-pycache.sh
node scripts/repro/repro-review-unit-web-dispatch-misclassified.mjs
bash scripts/repro/repro-babysit-merged-during-repair.sh
bash scripts/repro/repro-pr-body-empty-commit-defeats-landed-prefix.sh
bash scripts/repro/repro-pr-duplicate-close-landed.sh
bash scripts/repro/repro-pr-duplicate-close-same-branch.sh
bash scripts/repro/repro-ssh-approved-fix-stale-worktree-path.sh
bash scripts/repro/repro-worktree-add-implicit-upstream-config-lock.sh
