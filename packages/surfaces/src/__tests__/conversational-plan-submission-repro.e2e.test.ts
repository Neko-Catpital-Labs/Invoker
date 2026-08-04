import { describe, it, expect } from 'vitest';
import { isDraftingAuthorized } from '@invoker/planning-core';
import { buildPlanSystemPrompt } from '../slack/plan-conversation.js';

const PLAN_FILE_PATH = '/worktree/.invoker/plan-drafts/thread-pink.yaml';

const PINK_CONFIRMATION_ASK =
  "I found the full scope by sweeping the whole codebase — 9 component files plus index.css plus a test. "
  + 'I wrote the plan to plans/invoker-handoff.md. '
  + "Please confirm the 3 items at the bottom of the plan (safety invariants, the light-theme call, and go-ahead) "
  + "and I'll convert it to the YAML workflow stack and submit.";

describe('conversational planning submission ownership (repro for the pink-theme terminal incident)', () => {
  it('the drafting-authorized conversational prompt forbids self-submission and hands approval to the surface', () => {
    const prompt = buildPlanSystemPrompt('master', 'https://github.com/acme/repo.git', {
      conversationalPlanning: true,
      draftingAuthorized: true,
      planFilePath: PLAN_FILE_PATH,
    });

    expect(prompt).not.toContain("proceed through the skill's review/submission steps");
    expect(prompt).toContain('Only the hosting surface (the Slack orchestrator or the in-app planner) may submit the plan');
    expect(prompt).toContain('Never run `invoker-cli`, `invoker_submit_plan`, `scripts/headless-ipc.js`');
    expect(prompt).toContain("overrides the plan-to-invoker skill's Harness handoff mode");
  });

  it('the conversational prompt advertises the plan-draft file so file-draft detection stages approval', () => {
    const prompt = buildPlanSystemPrompt('master', 'https://github.com/acme/repo.git', {
      conversationalPlanning: true,
      draftingAuthorized: true,
      planFilePath: PLAN_FILE_PATH,
    });

    expect(prompt).toContain(PLAN_FILE_PATH);
    expect(prompt).toContain('write the COMPLETE YAML');
  });

  it('the direct Slack plan prompt already has both protections the conversational prompt lacks', () => {
    const prompt = buildPlanSystemPrompt('master', 'https://github.com/acme/repo.git', {
      conversationalPlanning: false,
      planFilePath: PLAN_FILE_PATH,
    });

    expect(prompt).toContain('Only the Slack orchestrator may submit the plan after approval');
    expect(prompt).toContain(PLAN_FILE_PATH);
  });

  it('the real pink-theme confirmation exchange never even authorized drafting — the text gate is advisory only', () => {
    const authorized = isDraftingAuthorized('yes', [
      { role: 'user', content: 'lets change the theme of the app from black to pink' },
      { role: 'assistant', content: PINK_CONFIRMATION_ASK },
    ]);

    expect(authorized).toBe(false);
  });
});
