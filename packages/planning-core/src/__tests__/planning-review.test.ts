import { describe, expect, it } from 'vitest';
import { preparePlanningReview, submitPlanningReview } from '../planning-review.js';

const planText = [
  'name: Shared planning review',
  'tasks:',
  '  - id: implement',
  '    description: Implement the shared review contract',
].join('\n');

describe('preparePlanningReview', () => {
  it('returns the canonical review draft for require mode', () => {
    const result = preparePlanningReview({
      plannerOutput: planText,
      confirmationMode: 'require',
    });

    expect(result).toMatchObject({
      planText,
      summary: { name: 'Shared planning review', taskCount: 1 },
      confirmationMode: 'require',
      confirmationText: 'Approve to submit this exact YAML. Cancel keeps the draft. Discard removes it.',
    });
  });

  it('keeps the same draft content in auto-submit mode', () => {
    const result = preparePlanningReview({
      plannerOutput: `Here you go:\n\`\`\`yaml\n${planText}\n\`\`\``,
      extractDraftPlanText: (output) => output.match(/```yaml\n([\s\S]*?)\n```/)?.[1] ?? null,
      confirmationMode: 'auto_submit',
    });

    expect(result).toMatchObject({
      planText,
      summary: { name: 'Shared planning review', taskCount: 1 },
      confirmationMode: 'auto_submit',
      confirmationText: 'Auto-submit is enabled. Submit this exact YAML now.',
    });
  });

  it('returns the planner reply when no valid draft exists', () => {
    const result = preparePlanningReview({
      plannerOutput: 'name: incomplete',
      confirmationMode: 'require',
    });

    expect(result).toEqual({ kind: 'message', reply: 'name: incomplete' });
  });
});

describe('submitPlanningReview', () => {
  it('rejects when there is no draft plan text', async () => {
    const result = await submitPlanningReview({
      planText: undefined,
      loadPlan: async () => ({ planName: 'x', workflowId: 'wf-1' }),
    });

    expect(result).toEqual({
      ok: false,
      error: 'No complete plan drafted yet. Ask the AI to create a full plan, then submit again.',
    });
  });

  it('rejects when the draft plan text cannot be summarized', async () => {
    const result = await submitPlanningReview({
      planText: 'name: incomplete',
      loadPlan: async () => ({ planName: 'x', workflowId: 'wf-1' }),
    });

    expect(result).toEqual({
      ok: false,
      error: 'I found a draft plan but could not read it. Ask the AI to regenerate the plan, then submit again.',
    });
  });

  it('loads and returns the approved plan on success', async () => {
    const result = await submitPlanningReview({
      planText,
      loadPlan: async (text) => {
        expect(text).toBe(planText);
        return { planName: 'Shared planning review', workflowId: 'wf-1', workflowIds: ['wf-1'], workflowCount: 1 };
      },
    });

    expect(result).toMatchObject({
      ok: true,
      planName: 'Shared planning review',
      workflowId: 'wf-1',
      workflowIds: ['wf-1'],
      workflowCount: 1,
      summary: { name: 'Shared planning review', taskCount: 1 },
    });
  });

  it('surfaces errors thrown by loadPlan', async () => {
    const result = await submitPlanningReview({
      planText,
      loadPlan: async () => {
        throw new Error('boom');
      },
    });

    expect(result).toEqual({ ok: false, error: 'boom' });
  });
});
