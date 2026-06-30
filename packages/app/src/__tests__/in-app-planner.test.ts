import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanConversation } from '@invoker/surfaces';
import { planFromGoal } from '../in-app-planner.js';

const VALID_PLAN = `Here is the plan.

\`\`\`yaml
name: Mock Plan
onFinish: none
tasks:
  - id: first
    description: First task
    command: echo first
\`\`\``;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('planFromGoal', () => {
  it('asks for a goal before planning', async () => {
    const loadGeneratedPlan = vi.fn();

    await expect(planFromGoal({ goal: '   ' }, {
      config: {},
      loadGeneratedPlan,
    })).resolves.toEqual({ ok: false, error: 'Describe a goal first.' });

    expect(loadGeneratedPlan).not.toHaveBeenCalled();
  });

  it('rejects unknown planner presets before planning', async () => {
    const loadGeneratedPlan = vi.fn();

    await expect(planFromGoal({ goal: 'Add README', presetKey: 'bad' }, {
      config: {},
      loadGeneratedPlan,
    })).resolves.toEqual({ ok: false, error: 'Unknown planner preset "bad".' });

    expect(loadGeneratedPlan).not.toHaveBeenCalled();
  });

  it('loads generated YAML as a preview without starting execution', async () => {
    const sendMessage = vi.spyOn(PlanConversation.prototype, 'sendMessage').mockResolvedValue(VALID_PLAN);
    const loadGeneratedPlan = vi.fn().mockResolvedValue({ planName: 'Mock Plan', workflowId: 'wf-1' });

    await expect(planFromGoal({ goal: '  Add README  ' }, {
      config: {},
      loadGeneratedPlan,
    })).resolves.toEqual({ ok: true, planName: 'Mock Plan', workflowId: 'wf-1' });

    expect(sendMessage).toHaveBeenCalledWith('Add README');
    expect(loadGeneratedPlan).toHaveBeenCalledTimes(1);
    expect(loadGeneratedPlan.mock.calls[0]?.[0]).toContain('name: Mock Plan');
  });

  it('does not load invalid planner output', async () => {
    vi.spyOn(PlanConversation.prototype, 'sendMessage').mockResolvedValue('No YAML here.');
    const loadGeneratedPlan = vi.fn();

    await expect(planFromGoal({ goal: 'Add README' }, {
      config: {},
      loadGeneratedPlan,
    })).resolves.toEqual({ ok: false, error: 'Planner did not return a valid YAML plan.' });

    expect(loadGeneratedPlan).not.toHaveBeenCalled();
  });
});
