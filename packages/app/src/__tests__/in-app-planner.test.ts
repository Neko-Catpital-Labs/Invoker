import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanConversation } from '@invoker/surfaces';
import { planFromGoal, type InAppPlannerDeps } from '../in-app-planner.js';

const validPlannerReply = `Here is the plan:

\`\`\`yaml
name: Preview Plan
tasks:
  - id: inspect
    description: Inspect the current implementation
\`\`\`
`;

function createDeps(loadGeneratedPlan = vi.fn()): InAppPlannerDeps {
  return {
    config: {},
    loadGeneratedPlan,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('planFromGoal', () => {
  it('returns an error for an empty goal', async () => {
    const loadGeneratedPlan = vi.fn();

    await expect(planFromGoal({ goal: '   ' }, createDeps(loadGeneratedPlan))).resolves.toEqual({
      ok: false,
      error: 'Describe a goal first.',
    });
    expect(loadGeneratedPlan).not.toHaveBeenCalled();
  });

  it('returns an error for an unknown preset', async () => {
    const loadGeneratedPlan = vi.fn();

    await expect(planFromGoal({ goal: 'Build it', preset: 'bad' }, createDeps(loadGeneratedPlan))).resolves.toEqual({
      ok: false,
      error: 'Unknown planner preset "bad".',
    });
    expect(loadGeneratedPlan).not.toHaveBeenCalled();
  });

  it('loads a generated YAML plan preview once', async () => {
    vi.spyOn(PlanConversation.prototype, 'sendMessage').mockResolvedValue(validPlannerReply);
    const loadGeneratedPlan = vi.fn().mockResolvedValue({
      planName: 'Preview Plan',
      workflowId: 'wf-1',
    });

    await expect(planFromGoal({ goal: 'Build a bridge' }, createDeps(loadGeneratedPlan))).resolves.toEqual({
      ok: true,
      planName: 'Preview Plan',
      workflowId: 'wf-1',
    });
    expect(loadGeneratedPlan).toHaveBeenCalledTimes(1);
    expect(loadGeneratedPlan.mock.calls[0][0]).toContain('name: Preview Plan');
  });

  it('returns an error when the planner reply has no valid YAML plan', async () => {
    vi.spyOn(PlanConversation.prototype, 'sendMessage').mockResolvedValue('No plan here.');
    const loadGeneratedPlan = vi.fn();

    await expect(planFromGoal({ goal: 'Build a bridge' }, createDeps(loadGeneratedPlan))).resolves.toEqual({
      ok: false,
      error: 'Planner did not return a valid YAML plan.',
    });
    expect(loadGeneratedPlan).not.toHaveBeenCalled();
  });
});
