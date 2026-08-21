import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanConversation } from '../../../surfaces/src/index.ts';
import {
  createInAppPlanningChatSessions,
  createPlanningChatSession,
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

const VALID_PLAN_TEXT = `name: Mock Plan
onFinish: none
tasks:
  - id: first
    description: First task
    command: echo first`;

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

  // Regression for the '?'-only authorization predicate (CodeRabbit review on
  // PR #9967): a question without ASCII question-mark punctuation must not be
  // mistaken for the informational-answer turn the ad665bff sidecar-approval
  // gate (see incident test in planning-chat-e2e-acceptance.test.ts) allows
  // through without an explicit draft request.
  it('keeps a punctuation-free question from bypassing the sidecar draft-authorization gate', async () => {
    const workingDir = mkdtempSync(join(tmpdir(), 'planning-draft-gate-punctuation-free-'));
    const sessions = createInAppPlanningChatSessions();
    const planningCommandBuilder = vi.fn(() => ({ command: 'planner', args: ['prompt'] }));
    let sessionId: string | undefined;
    try {
      const created = await createPlanningChatSession({}, {
        config: {},
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        workingDir,
      });
      if (!created.ok) throw new Error(created.error);
      sessionId = created.session.id;

      vi.spyOn(PlanConversation.prototype, 'spawnPlanner').mockImplementationOnce(function writeSidecarDraft() {
        const planDraftPath = this.planDraftFilePath();
        if (!planDraftPath) throw new Error('Repro requires a plan draft path.');
        writeFileSync(planDraftPath, VALID_PLAN_TEXT, 'utf8');
        return Promise.resolve('I wrote a plan to the draft file.');
      });

      const result = await sendPlanningChatMessage({
        sessionId,
        // No draft intent, and no ASCII '?' — a question the old
        // `!message.includes('?')` predicate would have missed.
        message: 'What files are in this repo',
      }, {
        config: {},
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        workingDir,
      });

      if (!result.ok) throw new Error(result.error);
      expect(result.draftPlanAvailable).toBe(false);
      expect(sessions.get(sessionId)?.status).not.toBe('draft_ready');
      expect(sessions.get(sessionId)?.draftPlanText).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
      rmSync(workingDir, { recursive: true, force: true });
    }
  });
});
