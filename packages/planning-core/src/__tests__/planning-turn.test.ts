import { describe, expect, it } from 'vitest';
import { evaluatePlanningTurn } from '../planning-turn.js';

const planText = [
  'name: Shared planning lifecycle',
  'tasks:',
  '  - id: implement',
  '    description: Implement the shared lifecycle',
].join('\n');

describe('evaluatePlanningTurn', () => {
  it('returns an ordinary message when drafting is not authorized', () => {
    expect(evaluatePlanningTurn({
      userMessage: 'What would this involve?',
      messagesBeforeTurn: [],
      assistantReply: 'Here is the scope.',
      immediateDraftPlanText: planText,
    })).toEqual({
      kind: 'message',
      text: 'Here is the scope.',
      status: 'still_discussing',
      draftingAuthorized: false,
    });
  });

  it('returns the exact current-turn YAML snapshot when drafting is authorized', () => {
    expect(evaluatePlanningTurn({
      userMessage: 'Please draft the plan',
      messagesBeforeTurn: [],
      assistantReply: 'Drafted it.',
      immediateDraftPlanText: planText,
    })).toMatchObject({
      kind: 'draft_ready',
      planText,
      draftingAuthorized: true,
      summary: { name: 'Shared planning lifecycle', taskCount: 1 },
    });
  });

  it('does not expose a draft when the candidate YAML is invalid', () => {
    expect(evaluatePlanningTurn({
      userMessage: 'Please draft the plan',
      messagesBeforeTurn: [],
      assistantReply: 'Can you clarify the repository?',
      immediateDraftPlanText: 'name: incomplete',
    })).toEqual({
      kind: 'message',
      text: 'Can you clarify the repository?',
      status: 'waiting_for_answer',
      draftingAuthorized: true,
    });
  });
});
