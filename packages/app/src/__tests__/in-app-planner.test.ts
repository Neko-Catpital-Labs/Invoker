import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanConversation } from '@invoker/surfaces';
import { planFromGoal } from '../in-app-planner.js';
import type { InAppPlannerDeps } from '../in-app-planner.js';

const VALID_PLAN_REPLY = `Generated plan:

\`\`\`yaml
name: Preview Plan
repoUrl: git@github.com:test/repo.git
tasks:
  - id: implement-preview
    description: Implement the preview path
    prompt: Add the bridge
    dependencies: []
\`\`\`
`;

function makeDeps(overrides: Partial<InAppPlannerDeps> = {}): InAppPlannerDeps {
  return {
    loadGeneratedPlan: vi.fn(async () => ({
      planName: 'Preview Plan',
      workflowId: 'wf-preview',
    })),
    log: vi.fn(),
    ...overrides,
  };
}

describe('planFromGoal', () => {
  beforeEach(() => {
    vi.spyOn(PlanConversation.prototype, 'sendMessage').mockResolvedValue(VALID_PLAN_REPLY);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the empty-goal validation error before planning', async () => {
    const deps = makeDeps();

    await expect(planFromGoal({ goal: '   ' }, deps)).resolves.toEqual({
      ok: false,
      error: 'Describe a goal first.',
    });
    expect(PlanConversation.prototype.sendMessage).not.toHaveBeenCalled();
    expect(deps.loadGeneratedPlan).not.toHaveBeenCalled();
  });

  it('returns an unknown preset validation error before planning', async () => {
    const deps = makeDeps();

    await expect(planFromGoal({ goal: 'Build it', preset: 'bad' }, deps)).resolves.toEqual({
      ok: false,
      error: 'Unknown planner preset "bad".',
    });
    expect(PlanConversation.prototype.sendMessage).not.toHaveBeenCalled();
    expect(deps.loadGeneratedPlan).not.toHaveBeenCalled();
  });

  it('loads valid generated YAML exactly once and returns the preview identity', async () => {
    const deps = makeDeps();

    await expect(planFromGoal({ goal: '  Build the preview bridge  ' }, deps)).resolves.toEqual({
      ok: true,
      planName: 'Preview Plan',
      workflowId: 'wf-preview',
    });

    expect(PlanConversation.prototype.sendMessage).toHaveBeenCalledWith('Build the preview bridge');
    expect(deps.loadGeneratedPlan).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.loadGeneratedPlan).mock.calls[0]?.[0]).toContain('name: Preview Plan');
  });

  it('returns an error and does not load when the planner reply has no YAML plan', async () => {
    vi.mocked(PlanConversation.prototype.sendMessage).mockResolvedValueOnce('I need more details.');
    const deps = makeDeps();

    await expect(planFromGoal({ goal: 'Build something' }, deps)).resolves.toEqual({
      ok: false,
      error: 'Planner did not return a valid YAML plan.',
    });
    expect(deps.loadGeneratedPlan).not.toHaveBeenCalled();
  });
});
