import { describe, expect, it } from 'vitest';
import { buildPlanSystemPrompt } from '../slack/plan-conversation.js';

describe('plan draft-file activation prompt policy', () => {
  it('keeps direct plan mode ready to draft YAML by default', () => {
    const prompt = buildPlanSystemPrompt('main', 'git@github.com:test/repo.git');

    expect(prompt).toContain('Generate a YAML task plan');
    expect(prompt).toContain('repoUrl: "git@github.com:test/repo.git"');
    expect(prompt).toContain('name: "Plan Name"');
    expect(prompt).toContain('When ready, output the plan inside a ```yaml code block');
    expect(prompt).toContain('After generating a plan, tell the user they can confirm execution');
  });

  it('keeps YAML and draft-file mechanics unavailable before conversational authorization', () => {
    const prompt = buildPlanSystemPrompt('main', undefined, {
      conversationalPlanning: true,
      draftingAuthorized: false,
    });

    expect(prompt).toContain('conversational planning mode');
    expect(prompt).toContain('Drafting is not authorized yet');
    expect(prompt).toContain('do NOT write a draft plan file');
    expect(prompt).toContain('Ask scoping questions first');
    expect(prompt).toContain('edge cases, corner cases, architecture choices, ambiguity');
    expect(prompt).toContain('explain like the user is five');
    expect(prompt).not.toContain('name: "Plan Name"');
    expect(prompt).not.toContain('When ready, output the plan inside a ```yaml code block');
    expect(prompt).not.toContain('confirm execution');
  });

  it('restores YAML drafting instructions after conversational authorization', () => {
    const prompt = buildPlanSystemPrompt('develop', undefined, {
      conversationalPlanning: true,
      draftingAuthorized: true,
    });

    expect(prompt).toContain('The user has explicitly approved drafting');
    expect(prompt).toContain('baseBranch: develop');
    expect(prompt).toContain('name: "Plan Name"');
    expect(prompt).toContain('When ready, output the plan inside a ```yaml code block');
    expect(prompt).toContain('After generating a plan, tell the user they can confirm execution');
    expect(prompt).toContain('pnpm run test:all');
  });
});
