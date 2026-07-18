#!/usr/bin/env bash
set -euo pipefail

# CodeRabbit PR #3049 (packages/app/src/in-app-planner.ts):
# submitPlanningChatDraft has two data-integrity gaps.
#
# 1) Missing error handling: loadPlannerSurfaces()/summarizePlanText and
#    deps.loadGeneratedPlan(planText) run WITHOUT try/catch. Any failure (e.g.
#    orchestrator.loadPlan throwing on a task-id collision) REJECTS the promise
#    instead of returning the declared InAppPlanningSubmitResponse
#    `{ ok: false, error }` shape.
#
# 2) No submission guard: the session is never removed after a successful
#    submit, so a second submitPlanningChatDraft with the same sessionId
#    (double-click / retry) re-runs loadGeneratedPlan — a non-idempotent write
#    (orchestrator.loadPlan) — and creates a SECOND workflow from one draft.
#
# This repro exercises both:
#   - Buggy -> loadGeneratedPlan throw rejects, AND a double submit calls
#     loadGeneratedPlan twice -> vitest FAIL -> repro FAIL.
#   - Fixed -> throw becomes { ok: false, error }, AND the second submit is
#     rejected because the session was cleared (loadGeneratedPlan called once)
#     -> repro PASS.

REPO_ROOT="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
APP_DIR="$REPO_ROOT/packages/app"
VITEST="$APP_DIR/node_modules/.bin/vitest"

if [[ ! -x "$VITEST" ]]; then
  echo "[repro] FAIL: no vitest binary at $VITEST; run 'pnpm install' at the repo root first."
  exit 1
fi

SLUG=".repro-coderabbit-pr3049-submit-idempotency-guard"
TEST_DIR="$APP_DIR/$SLUG"
TEST_FILE="$TEST_DIR/repro.test.ts"
mkdir -p "$TEST_DIR"
trap 'rm -rf "$TEST_DIR"' EXIT

cat > "$TEST_FILE" <<'TS'
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PlanConversation } from '@invoker/surfaces';
import {
  createInAppPlanningChatSessions,
  sendPlanningChatMessage,
  submitPlanningChatDraft,
} from '../src/in-app-planner.js';

const VALID_PLAN = `Here is the plan.

\`\`\`yaml
name: Mock Plan
onFinish: none
tasks:
  - id: first
    description: First task
    command: echo first
  - id: second
    description: Second task
    dependencies: [first]
    command: echo second
\`\`\``;

const planningCommandBuilder = () => ({ command: 'planner', args: ['prompt'] });

afterEach(() => {
  vi.restoreAllMocks();
});

async function draftedSession() {
  vi.spyOn(PlanConversation.prototype, 'spawnPlanner').mockResolvedValue(VALID_PLAN);
  const sessions = createInAppPlanningChatSessions();
  const sent = await sendPlanningChatMessage(
    { message: 'draft the plan', presetKey: 'codex' } as never,
    {
      config: {} as never,
      loadGeneratedPlan: async () => ({ planName: 'Mock Plan', workflowId: 'wf' }),
      sessions,
      planningCommandBuilder,
    },
  );
  if (!sent.ok) throw new Error(sent.error);
  return { sessions, sessionId: sent.sessionId };
}

describe('submitPlanningChatDraft', () => {
  it('returns { ok: false } instead of rejecting when loadGeneratedPlan throws', async () => {
    const { sessions, sessionId } = await draftedSession();

    const result = await submitPlanningChatDraft(
      { sessionId } as never,
      {
        sessions,
        loadGeneratedPlan: async () => {
          throw new Error('task-id collision loading plan');
        },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('task-id collision loading plan');
    }
  });

  it('does not create a second workflow when the same draft is submitted twice', async () => {
    const { sessions, sessionId } = await draftedSession();
    const loadGeneratedPlan = vi
      .fn()
      .mockResolvedValue({ planName: 'Mock Plan', workflowId: 'wf-1' });

    const first = await submitPlanningChatDraft({ sessionId } as never, { sessions, loadGeneratedPlan });
    expect(first).toEqual({ ok: true, planName: 'Mock Plan', workflowId: 'wf-1' });

    // Double-click / retry: the same sessionId is submitted again.
    const second = await submitPlanningChatDraft({ sessionId } as never, { sessions, loadGeneratedPlan });

    // The non-idempotent loadGeneratedPlan (orchestrator.loadPlan) must run once.
    expect(loadGeneratedPlan).toHaveBeenCalledTimes(1);
    // The second submit must be rejected, not silently create a duplicate workflow.
    expect(second.ok).toBe(false);
  });
});
TS

set +e
( cd "$APP_DIR" && "$VITEST" run --reporter=dot "$SLUG/repro.test.ts" )
CODE=$?
set -e

if [[ "$CODE" -ne 0 ]]; then
  echo "[repro] FAIL: submitPlanningChatDraft rejects on load errors and/or re-submits the same draft into a duplicate workflow (vitest exit $CODE)."
  exit 1
fi

echo "[repro] PASS: submitPlanningChatDraft catches load errors as { ok: false } and clears the session so a repeated submit cannot create a duplicate workflow."
exit 0
