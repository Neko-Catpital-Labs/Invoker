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
  it('the drafting-authorized conversational prompt orders the model to run review/submission itself', () => {
    const prompt = buildPlanSystemPrompt('master', 'https://github.com/acme/repo.git', {
      conversationalPlanning: true,
      draftingAuthorized: true,
      planFilePath: PLAN_FILE_PATH,
    });

    expect(prompt).toContain("proceed through the skill's review/submission steps");
    expect(prompt).not.toContain('may submit the plan after approval');
    expect(prompt).not.toMatch(/do not (?:call|run|submit).*invoker/i);
  });

  it('the conversational prompt never advertises the plan-draft file, so file-draft detection cannot stage approval', () => {
    const prompt = buildPlanSystemPrompt('master', 'https://github.com/acme/repo.git', {
      conversationalPlanning: true,
      draftingAuthorized: true,
      planFilePath: PLAN_FILE_PATH,
    });

    expect(prompt).not.toContain(PLAN_FILE_PATH);
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
