import { describe, expect, it } from 'vitest';
import {
  appendPlanningTurn,
  createPlanningSessionState,
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

