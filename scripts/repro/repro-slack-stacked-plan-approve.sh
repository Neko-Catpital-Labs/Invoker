#!/usr/bin/env bash
# Battle-test: Slack plan-draft Approve starts every workflow in a stacked
# YAML plan and records all resulting workflowIds on the draft, instead of
# starting only one workflow and recording `markSubmitted(draft, [])`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "==> slack-manager: start_plan fans a stacked run out to every workflow_created event"
pnpm --filter @invoker/slack-manager exec vitest run src/__tests__/command-handler.test.ts

echo "==> surfaces: approveSlackPlanDraft forwards every workflowId into markSubmitted"
pnpm --filter @invoker/surfaces exec vitest run src/__tests__/slack-plan-draft-approve.test.ts

echo "==> app: headless.run parses stacked workflows via parsePlanSubmissionBundleFile"
pnpm --filter @invoker/app exec vitest run src/__tests__/plan-parser.test.ts -t parsePlanSubmissionBundleFile

echo "[repro] PASS: stacked Slack plan Approve starts every workflow and records all workflowIds"
