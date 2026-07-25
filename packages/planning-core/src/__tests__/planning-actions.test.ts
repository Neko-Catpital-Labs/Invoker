import { describe, expect, it } from 'vitest';
import {
  appendPlanningTurn,
  approvePlanningDraft,
  createPlanningSessionState,
  runPlanToInvoker,
} from '../planning-actions.js';

const planText = [
  'name: Shared planning actions',
  'tasks:',
  '  - id: implement',
  '    description: Implement the shared actions',
].join('\n');

describe('appendPlanningTurn', () => {
  it('appends a discussion turn when drafting is not authorized', async () => {
    const state = createPlanningSessionState('thread-1');
    const result = await appendPlanningTurn({
      state,
      userMessage: 'What would this involve?',
      send: async () => 'Here is the scope.',
    });

    expect(result.reply).toBe('Here is the scope.');
    expect(result.draftingAuthorized).toBe(false);
    expect(result.draftPlanText).toBeUndefined();
    expect(result.state.status).toBe('still_discussing');
    expect(result.state.harnessSessionId).toBe('thread-1');
    expect(result.state.messages).toEqual([
      { role: 'user', content: 'What would this involve?' },
      { role: 'assistant', content: 'Here is the scope.' },
    ]);
  });

  it('promotes to draft_ready when drafting is authorized and a draft is extracted', async () => {
    const state = createPlanningSessionState();
    const result = await appendPlanningTurn({
      state,
      userMessage: 'Please draft the plan',
      send: async () => 'Drafted it.',
      extractDraftPlanText: () => planText,
    });

    expect(result.draftingAuthorized).toBe(true);
    expect(result.draftPlanText).toBe(planText);
    expect(result.summary).toMatchObject({ name: 'Shared planning actions', taskCount: 1 });
    expect(result.state.status).toBe('draft_ready');
    expect(result.state.draftPlanText).toBe(planText);
  });

  it('carries forward prior messages across turns', async () => {
    let state = createPlanningSessionState();
    const first = await appendPlanningTurn({
      state,
      userMessage: 'Hi',
      send: async () => 'Hello, what should we build?',
    });
    state = first.state;

    const second = await appendPlanningTurn({
      state,
      userMessage: 'A widget',
      send: async () => 'Got it.',
    });

    expect(second.state.messages).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello, what should we build?' },
      { role: 'user', content: 'A widget' },
      { role: 'assistant', content: 'Got it.' },
    ]);
  });

  it('does not require draft authorization when explicitly disabled', async () => {
    const state = createPlanningSessionState();
    const result = await appendPlanningTurn({
      state,
      userMessage: 'anything',
      send: async () => 'Drafted it.',
      extractDraftPlanText: () => planText,
      requireDraftAuthorization: false,
    });

    expect(result.draftingAuthorized).toBe(true);
    expect(result.state.status).toBe('draft_ready');
  });
});

describe('runPlanToInvoker', () => {
  it('returns a draft_ready result when the conversion produces a valid plan', async () => {
    const result = await runPlanToInvoker({
      convert: async () => planText,
    });

    expect(result).toMatchObject({
      kind: 'draft_ready',
      planText,
      summary: { name: 'Shared planning actions', taskCount: 1 },
      reply: planText,
    });
  });

  it('extracts the plan text from a wrapped output before evaluating it', async () => {
    const wrapped = `Here you go:\n\`\`\`yaml\n${planText}\n\`\`\``;
    const result = await runPlanToInvoker({
      convert: async () => wrapped,
      extractDraftPlanText: (output) => output.match(/```yaml\n([\s\S]*?)\n```/)?.[1] ?? null,
    });

    expect(result).toMatchObject({ kind: 'draft_ready', planText });
  });

  it('returns a message result when no valid plan is produced', async () => {
    const result = await runPlanToInvoker({
      convert: async () => 'name: incomplete',
    });

    expect(result).toEqual({ kind: 'message', reply: 'name: incomplete' });
  });
});

describe('approvePlanningDraft', () => {
  it('rejects when there is no draft plan text', async () => {
    const result = await approvePlanningDraft({
      planText: undefined,
      loadPlan: async () => ({ planName: 'x', workflowId: 'wf-1' }),
    });

    expect(result).toEqual({
      ok: false,
      error: 'No complete plan drafted yet. Ask the AI to create a full plan, then submit again.',
    });
  });

  it('rejects when the draft plan text cannot be summarized', async () => {
    const result = await approvePlanningDraft({
      planText: 'name: incomplete',
      loadPlan: async () => ({ planName: 'x', workflowId: 'wf-1' }),
    });

    expect(result).toEqual({
      ok: false,
      error: 'I found a draft plan but could not read it. Ask the AI to regenerate the plan, then submit again.',
    });
  });

  it('loads and returns the approved plan on success', async () => {
    const result = await approvePlanningDraft({
      planText,
      loadPlan: async (text) => {
        expect(text).toBe(planText);
        return { planName: 'Shared planning actions', workflowId: 'wf-1', workflowIds: ['wf-1'], workflowCount: 1 };
      },
    });

    expect(result).toMatchObject({
      ok: true,
      planName: 'Shared planning actions',
      workflowId: 'wf-1',
      workflowIds: ['wf-1'],
      workflowCount: 1,
      summary: { name: 'Shared planning actions', taskCount: 1 },
    });
  });

  it('surfaces errors thrown by loadPlan', async () => {
    const result = await approvePlanningDraft({
      planText,
      loadPlan: async () => {
        throw new Error('boom');
      },
    });

    expect(result).toEqual({ ok: false, error: 'boom' });
  });
});
