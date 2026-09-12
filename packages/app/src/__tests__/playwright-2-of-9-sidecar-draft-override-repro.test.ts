import { describe, expect, it } from 'vitest';
import {
  createInAppPlanningChatSessions,
  sendPlanningChatMessage,
} from '../in-app-planner.js';

// Repro for CI job `playwright / 2-of-9`, first observed failing at
// 182d0fd3c73e66fa8759420115264a456e88e3c5 (e2e/planning-review-scroll.spec.ts:
// "a long Review draft panel scrolls with the mouse wheel").
//
// Root cause: that commit (#9967) added a `sidecarDraftApproved` bypass in
// sendPlanningChatMessage (packages/app/src/in-app-planner.ts) gated on
// `!deps.plannerReplyOverride`. Every Electron/Playwright e2e spec that
// simulates a planner reply via `window.invoker.setTestPlanningChatResponse`
// goes through `plannerReplyOverride` (see the `invoker:planning-chat-send`
// handler in packages/app/src/main.ts and
// packages/app/src/ipc/gui-mutation-handlers.ts), so `sidecarDraftApproved`
// is now unconditionally false for every e2e test-mode planning-chat send:
// there is no way for the test double to represent "the planner deliberately
// wrote a sidecar draft file", the real (non-override) scenario this bypass
// exists for (incident ad665bff). planning-review-scroll.spec.ts sends a
// plain, non-question, non-draft-intent message and expects the resulting
// draft to become review-ready ("Review draft" heading visible), mirroring
// that sidecar-recovery flow -- so with the guard forcing
// sidecarDraftApproved=false, the session never reaches draft_ready and the
// heading never renders.
//
// This calls the real sendPlanningChatMessage with a plannerReplyOverride
// built exactly the way the `invoker:planning-chat-send` handler wraps a
// `setTestPlanningChatResponse({ planYaml, reply })` payload, sends the same
// plain informational message the spec types into the terminal input, and
// asserts the session reaches `draft_ready` -- the same predicate the e2e
// test's "Review draft" heading depends on.

const PLAN_YAML = `name: Reaper workers for finished e2e and admin-bypass tasks
onFinish: none
tasks:
  - id: only
    description: Only task
    command: echo reaper
`;

// Mirrors the exact wrapping the `invoker:planning-chat-send` handler does
// for a `{ planYaml, reply }` test-override payload (main.ts and
// gui-mutation-handlers.ts, both: `` `${reply}\n\n\`\`\`yaml\n${planYaml}\n\`\`\`` ``).
function buildOverrideReply({ reply, planYaml }: { reply: string; planYaml: string }): string {
  return `${reply}\n\n\`\`\`yaml\n${planYaml}\n\`\`\``;
}

describe('playwright / 2-of-9 repro: sidecar-style test-override draft', () => {
  it('reaches draft_ready for a plain informational message, matching the ad665bff sidecar flow', async () => {
    const sessions = createInAppPlanningChatSessions();
    const result = await sendPlanningChatMessage(
      {
        // Same message shape the spec fills into the terminal input: a plain
        // repo URL, not a question and not an explicit "draft it" ask.
        message: 'github.com/Neko-Catpital-Labs/Invoker/',
        presetKey: 'codex',
      },
      {
        config: {} as never,
        loadGeneratedPlan: () => ({ planName: 'stub', workflowId: 'stub-workflow' }),
        sessions,
        planningCommandBuilder: () => ({ command: 'planner', args: ['prompt'] }),
        plannerReplyOverride: async () => buildOverrideReply({
          reply: 'I wrote the 3-slice plan to the draft file.',
          planYaml: PLAN_YAML,
        }),
        // Mirrors what the fixed `invoker:planning-chat-send` handler derives
        // from a `setTestPlanningChatResponse({ ..., sidecarDraft: true })`
        // payload (see main.ts / gui-mutation-handlers.ts).
        plannerReplyOverrideSidecarDraft: true,
      },
    );

    if (!result.ok) throw new Error(result.error);
    const session = sessions.get(result.sessionId);
    // eslint-disable-next-line no-console
    console.log(`[repro] session.status=${session?.status} draftPlanAvailable=${result.draftPlanAvailable}`);
    expect(session?.status).toBe('draft_ready');
    expect(result.draftPlanAvailable).toBe(true);
  });
});
