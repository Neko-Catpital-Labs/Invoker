import { describe, expect, it } from 'vitest';
import { isDraftingAuthorized } from '../lifecycle.js';
import { evaluatePlanningTurn } from '../planning-turn.js';

const validPlan = [
  'name: Incident corpus plan',
  'tasks:',
  '  - id: implement',
  '    description: Exercise the real conversation wording',
].join('\n');

const affectedTurns = [
  ['ad665bff', 'github.com/Neko-Catpital-Labs/Invoker/'],
  ['01bd9064', 'github.com/Neko-Catpital-Labs/Invoker, yes'],
  ['95535743', 'submit to inovker'],
  ['b35866a8', 'dont submi to slack. submit to invoker'],
  ['33cde460', 'first one'],
  ['6f3203c7', 'Yes please. do both of those and also make sure you ship the repro script'],
  ['8cae6f0f', 'Yes thats the one'],
] as const;

describe('planning review incident corpus from 2026-08-11', () => {
  it.each(affectedTurns)('%s stages valid YAML despite unmatched current-turn phrasing', (_session, userMessage) => {
    const messagesBeforeTurn = [{
      role: 'assistant' as const,
      content: 'The scope is resolved. Send the repository or choose the preferred option.',
    }];

    expect(isDraftingAuthorized(userMessage, messagesBeforeTurn)).toBe(false);
    expect(evaluatePlanningTurn({
      userMessage,
      messagesBeforeTurn,
      assistantReply: 'Plan written.',
      immediateDraftPlanText: validPlan,
    })).toMatchObject({
      kind: 'draft_ready',
      planText: validPlan,
      draftingAuthorized: false,
    });
  });
});
