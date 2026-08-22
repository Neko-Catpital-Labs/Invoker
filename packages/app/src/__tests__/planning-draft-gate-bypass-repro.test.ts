import { describe, expect, it, vi } from 'vitest';
import {
  createInAppPlanningChatSessions,
  sendPlanningChatMessage,
} from '../in-app-planner.js';

// Regression test for the draft-authorization gate bypass.
//
// Draft Gate Step 2 (c506ceaf9f, PR #5320) enforced: YAML the user never asked
// for must NOT become draft-ready. 5b6408e736 rewrote evaluatePlanningTurn so
// authorization only gated REPLACING an existing draft, and d14fac3858 passed
// requireDraftAuthorization: false whenever a fresh reply contained YAML.
// The gate now lives at the send-message layer: unauthorized inline YAML stays
// a conversation message; only a deliberate sidecar write after a plain answer
// is review-ready without an explicit ask (incident ad665bff).
const UNREQUESTED_YAML_REPLY = `Here is what I found, and incidentally a full YAML you did not ask for.

\`\`\`yaml
name: Mock Plan
onFinish: none
tasks:
  - id: first
    description: First task
    command: echo first
\`\`\``;

describe('draft gate bypass repro', () => {
  it('keeps unrequested YAML from becoming draft-ready on a fresh session', async () => {
    const sessions = createInAppPlanningChatSessions();
    const result = await sendPlanningChatMessage({
      // No draft intent, no prior assistant offer to draft.
      message: 'What files are in this repo?',
      presetKey: 'codex',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder: vi.fn(() => ({ command: 'planner', args: ['prompt'] })),
      plannerReplyOverride: async () => UNREQUESTED_YAML_REPLY,
    });

    if (!result.ok) throw new Error(result.error);
    expect(result.draftPlanAvailable).toBe(false);
    expect(sessions.get(result.sessionId)?.status).not.toBe('draft_ready');
    expect(sessions.get(result.sessionId)?.draftPlanText).toBeUndefined();
  });
});
