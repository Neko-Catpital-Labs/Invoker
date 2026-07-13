
import { describe, it, expect, vi } from 'vitest';
import {
  applyInvalidation,
  ACTION_SPECS,
  MUTATION_POLICIES,
  type InvalidationAction,
  type InvalidationDeps,
} from '../invalidation-policy.js';

type MockedDeps = InvalidationDeps & {
  cancelInFlight: ReturnType<typeof vi.fn>;
  retryTask: ReturnType<typeof vi.fn>;
  recreateTask: ReturnType<typeof vi.fn>;
  retryWorkflow: ReturnType<typeof vi.fn>;
  recreateWorkflow: ReturnType<typeof vi.fn>;
  recreateWorkflowFromFreshBase?: ReturnType<typeof vi.fn>;
  workflowFork?: ReturnType<typeof vi.fn>;
  scheduleOnly?: ReturnType<typeof vi.fn>;
  cascadeDownstream?: ReturnType<typeof vi.fn>;
};

function makeDeps(overrides: Partial<MockedDeps> = {}): MockedDeps {
  return {
    cancelInFlight: vi.fn(async () => undefined),
    retryTask: vi.fn(async () => []),
    recreateTask: vi.fn(async () => []),
    retryWorkflow: vi.fn(async () => []),
    recreateWorkflow: vi.fn(async () => []),
    ...overrides,
  } as MockedDeps;
}

describe('MUTATION_POLICIES', () => {
  it('matches the chart Decision Table for execution-spec mutations', () => {
    expect(MUTATION_POLICIES.command.action).toBe('recreateTask');
    expect(MUTATION_POLICIES.prompt.action).toBe('recreateTask');
    expect(MUTATION_POLICIES.executionAgent.action).toBe('recreateTask');
    expect(MUTATION_POLICIES.runnerKind.action).toBe('retryTask');
    expect(MUTATION_POLICIES.poolMemberId.action).toBe('recreateTask');
    expect(MUTATION_POLICIES.selectedExperiment.action).toBe('recreateTask');
    expect(MUTATION_POLICIES.selectedExperimentSet.action).toBe('recreateTask');
    expect(MUTATION_POLICIES.mergeMode.action).toBe('retryTask');
    expect(MUTATION_POLICIES.fixContext.action).toBe('retryTask');
    expect(MUTATION_POLICIES.rebaseAndRetry.action).toBe('recreateWorkflowFromFreshBase');
    // Step 15: external gate policy is the chart's intentional
    // non-invalidating outlier. Action upgraded from `'none'`
    // (Step 1 placeholder) to `'scheduleOnly'` so the policy table
    // expresses what really happens (an unblock-pass) and so
    // `applyInvalidation` can route the action through the
    // `scheduleOnly` dep WITHOUT calling `cancelInFlight`.
    expect(MUTATION_POLICIES.externalGatePolicy.action).toBe('scheduleOnly');
    expect(MUTATION_POLICIES.externalGatePolicy.invalidatesExecutionSpec).toBe(false);
    expect(MUTATION_POLICIES.externalGatePolicy.invalidateIfActive).toBe(false);
    // Step 11: graph topology is the lone fork-class / workflow-scope row.
    expect(MUTATION_POLICIES.topology.action).toBe('workflowFork');
    expect(MUTATION_POLICIES.topology.invalidatesExecutionSpec).toBe(true);
    expect(MUTATION_POLICIES.topology.invalidateIfActive).toBe(true);
  });

  it('marks every spec-changing mutation as invalidating-if-active', () => {
    for (const [key, policy] of Object.entries(MUTATION_POLICIES)) {
      // Step 15: `'scheduleOnly'` joins `'none'` as a
      // non-invalidating action class — gate-policy edits change
      // scheduling, not the execution ABI, so neither flag flips.
      if (
        policy.action === 'none' ||
        policy.action === 'scheduleOnly' ||
        policy.action === 'fixApprove' ||
        policy.action === 'fixReject'
      ) {
        expect(policy.invalidatesExecutionSpec, key).toBe(false);
        expect(policy.invalidateIfActive, key).toBe(false);
      } else {
        expect(policy.invalidatesExecutionSpec, key).toBe(true);
        expect(policy.invalidateIfActive, key).toBe(true);
      }
    }
  });

  // Step 15 lock-in: `externalGatePolicy` is the lone `'scheduleOnly'`
  // entry in the policy table, mirroring how `topology` is the lone
  // `'workflowFork'` entry. This pins the chart's "Change external
  // gate policy" row as the engine's only intentional non-invalidating
  // execution-spec-adjacent mutation.
  it('externalGatePolicy is the only scheduleOnly entry in the policy table', () => {
    const scheduleOnlyEntries = Object.entries(MUTATION_POLICIES).filter(
      ([, p]) => p.action === 'scheduleOnly',
    );
    expect(scheduleOnlyEntries.map(([k]) => k)).toEqual(['externalGatePolicy']);
  });

  it('is frozen — the policy table is a constant, not a mutable map', () => {
    expect(Object.isFrozen(MUTATION_POLICIES)).toBe(true);
  });
});

describe("applyInvalidation: action='none'", () => {
  it('returns [] and never calls cancelInFlight or any lifecycle dep', async () => {
    const deps = makeDeps();
    const out = await applyInvalidation('none', 'none', 'task-a', deps);
    expect(out).toEqual([]);
    expect(deps.cancelInFlight).not.toHaveBeenCalled();
    expect(deps.retryTask).not.toHaveBeenCalled();
    expect(deps.recreateTask).not.toHaveBeenCalled();
    expect(deps.retryWorkflow).not.toHaveBeenCalled();
    expect(deps.recreateWorkflow).not.toHaveBeenCalled();
  });

  it("rejects when action is 'none' but scope is not 'none'", async () => {
    const deps = makeDeps();
    await expect(
      applyInvalidation('task', 'none', 'task-a', deps),
    ).rejects.toThrow(/scope must be 'none'/);
    expect(deps.cancelInFlight).not.toHaveBeenCalled();
  });
});

describe('applyInvalidation: cancel-first ordering (Hard Invariant)', () => {
  it('calls cancelInFlight before retryTask', async () => {
    const deps = makeDeps();
    await applyInvalidation('task', 'retryTask', 'task-a', deps);
    expect(deps.cancelInFlight).toHaveBeenCalledWith('task', 'task-a');
    expect(deps.retryTask).toHaveBeenCalledWith('task-a');
    expect(deps.cancelInFlight.mock.invocationCallOrder[0]).toBeLessThan(
      deps.retryTask.mock.invocationCallOrder[0],
    );
  });

  it('calls cancelInFlight before recreateTask', async () => {
    const deps = makeDeps();
    await applyInvalidation('task', 'recreateTask', 'task-a', deps);
    expect(deps.cancelInFlight).toHaveBeenCalledWith('task', 'task-a');
    expect(deps.cancelInFlight.mock.invocationCallOrder[0]).toBeLessThan(
      deps.recreateTask.mock.invocationCallOrder[0],
    );
  });

  it('calls cancelInFlight before retryWorkflow', async () => {
    const deps = makeDeps();
    await applyInvalidation('workflow', 'retryWorkflow', 'wf-1', deps);
    expect(deps.cancelInFlight).toHaveBeenCalledWith('workflow', 'wf-1');
    expect(deps.cancelInFlight.mock.invocationCallOrder[0]).toBeLessThan(
      deps.retryWorkflow.mock.invocationCallOrder[0],
    );
  });

  it('calls cancelInFlight before recreateWorkflow', async () => {
    const deps = makeDeps();
    await applyInvalidation('workflow', 'recreateWorkflow', 'wf-1', deps);
    expect(deps.cancelInFlight.mock.invocationCallOrder[0]).toBeLessThan(
      deps.recreateWorkflow.mock.invocationCallOrder[0],
    );
  });

  it('calls cancelInFlight before recreateWorkflowFromFreshBase when dep is wired', async () => {
    const recreateWorkflowFromFreshBase = vi.fn(async () => []);
    const deps = makeDeps({ recreateWorkflowFromFreshBase });
    await applyInvalidation('workflow', 'recreateWorkflowFromFreshBase', 'wf-1', deps);
    expect(recreateWorkflowFromFreshBase).toHaveBeenCalledWith('wf-1');
    expect(deps.cancelInFlight.mock.invocationCallOrder[0]).toBeLessThan(
      recreateWorkflowFromFreshBase.mock.invocationCallOrder[0],
    );
  });
});

describe('applyInvalidation: cancel-first failure aborts the route', () => {
  it('rejects and never calls the lifecycle dep when cancelInFlight rejects (recreateTask)', async () => {
    const cancelError = new Error('cancel failed');
    const deps = makeDeps({
      cancelInFlight: vi.fn(async () => {
        throw cancelError;
      }),
    });
    await expect(
      applyInvalidation('task', 'recreateTask', 'task-a', deps),
    ).rejects.toBe(cancelError);
    expect(deps.recreateTask).not.toHaveBeenCalled();
  });

  it('rejects and never calls the lifecycle dep when cancelInFlight rejects (retryWorkflow)', async () => {
    const deps = makeDeps({
      cancelInFlight: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await expect(
      applyInvalidation('workflow', 'retryWorkflow', 'wf-1', deps),
    ).rejects.toThrow('boom');
    expect(deps.retryWorkflow).not.toHaveBeenCalled();
  });

  it('aborts recreateWorkflowFromFreshBase when cancel rejects', async () => {
    const recreateWorkflowFromFreshBase = vi.fn(async () => []);
    const deps = makeDeps({
      cancelInFlight: vi.fn(async () => {
        throw new Error('cancel exploded');
      }),
      recreateWorkflowFromFreshBase,
    });
    await expect(
      applyInvalidation('workflow', 'recreateWorkflowFromFreshBase', 'wf-1', deps),
    ).rejects.toThrow('cancel exploded');
    expect(recreateWorkflowFromFreshBase).not.toHaveBeenCalled();
  });
});

describe('applyInvalidation: scope/action mismatch', () => {
  it('rejects retryTask with workflow scope and never cancels', async () => {
    const deps = makeDeps();
    await expect(
      applyInvalidation('workflow', 'retryTask', 'task-a', deps),
    ).rejects.toThrow(/requires scope 'task'/);
    expect(deps.cancelInFlight).not.toHaveBeenCalled();
  });

  it('rejects recreateTask with workflow scope', async () => {
    const deps = makeDeps();
    await expect(
      applyInvalidation('workflow', 'recreateTask', 'task-a', deps),
    ).rejects.toThrow(/requires scope 'task'/);
    expect(deps.cancelInFlight).not.toHaveBeenCalled();
  });

  it('rejects retryWorkflow with task scope', async () => {
    const deps = makeDeps();
    await expect(
      applyInvalidation('task', 'retryWorkflow', 'wf-1', deps),
    ).rejects.toThrow(/requires scope 'workflow'/);
    expect(deps.cancelInFlight).not.toHaveBeenCalled();
  });

  it('rejects recreateWorkflow with task scope', async () => {
    const deps = makeDeps();
    await expect(
      applyInvalidation('task', 'recreateWorkflow', 'wf-1', deps),
    ).rejects.toThrow(/requires scope 'workflow'/);
  });

  it('rejects recreateWorkflowFromFreshBase with task scope', async () => {
    const deps = makeDeps({
      recreateWorkflowFromFreshBase: vi.fn(async () => []),
    });
    await expect(
      applyInvalidation('task', 'recreateWorkflowFromFreshBase', 'wf-1', deps),
    ).rejects.toThrow(/requires scope 'workflow'/);
  });

  it('rejects task-scoped invocation with workflow-only action and never cancels', async () => {
    const deps = makeDeps({
      recreateWorkflowFromFreshBase: vi.fn(async () => []),
    });
    await expect(
      applyInvalidation('task', 'recreateWorkflow', 'wf-1', deps),
    ).rejects.toThrow();
    expect(deps.cancelInFlight).not.toHaveBeenCalled();
    expect(deps.recreateWorkflow).not.toHaveBeenCalled();
  });
});

describe('applyInvalidation: recreateWorkflowFromFreshBase optional dep', () => {
  it('throws an explicit "not yet wired (Step 12)" error when dep is absent', async () => {
    const deps = makeDeps();
    await expect(
      applyInvalidation('workflow', 'recreateWorkflowFromFreshBase', 'wf-1', deps),
    ).rejects.toThrow(/not yet wired \(Step 12\)/);
  });

  it('routes to the provided dep when present', async () => {
    const recreateWorkflowFromFreshBase = vi.fn(async () => []);
    const deps = makeDeps({ recreateWorkflowFromFreshBase });
    await applyInvalidation('workflow', 'recreateWorkflowFromFreshBase', 'wf-1', deps);
    expect(recreateWorkflowFromFreshBase).toHaveBeenCalledWith('wf-1');
  });
});

describe('applyInvalidation: workflowFork optional dep', () => {
  it('throws an explicit missing-dep error when dep is absent', async () => {
    const deps = makeDeps();
    await expect(
      applyInvalidation('workflow', 'workflowFork', 'wf-1', deps),
    ).rejects.toThrow(/'workflowFork' dep is missing/);
  });

  it('routes to the provided dep when present', async () => {
    const workflowFork = vi.fn(async () => []);
    const deps = makeDeps({ workflowFork });
    await applyInvalidation('workflow', 'workflowFork', 'wf-1', deps);
    expect(workflowFork).toHaveBeenCalledWith('wf-1');
  });

  it('rejects task-scoped invocation with workflowFork action', async () => {
    const deps = makeDeps({ workflowFork: vi.fn(async () => []) });
    await expect(
      applyInvalidation('task', 'workflowFork', 'task-a', deps),
    ).rejects.toThrow(/requires scope 'workflow'/);
    expect(deps.cancelInFlight).not.toHaveBeenCalled();
  });

  it('cancel-first ordering applies to workflowFork', async () => {
    const workflowFork = vi.fn(async () => []);
    const deps = makeDeps({ workflowFork });
    await applyInvalidation('workflow', 'workflowFork', 'wf-1', deps);
    expect(deps.cancelInFlight).toHaveBeenCalledWith('workflow', 'wf-1');
    expect(deps.cancelInFlight.mock.invocationCallOrder[0]).toBeLessThan(
      workflowFork.mock.invocationCallOrder[0],
    );
  });
});

// Step 15 (`docs/architecture/task-invalidation-roadmap.md`): the
// `'scheduleOnly'` action represents the chart's intentional
// non-invalidating outlier — "Change external gate policy" is a
// scheduling-policy edit, not an execution-spec edit. The router
// MUST skip `cancelInFlight` for this action and instead invoke
// `deps.scheduleOnly(taskId)` to trigger an unblock-pass that
// re-evaluates tasks newly unblocked by the gate-policy change.
// Active execution lineage and any in-flight attempts are preserved.
describe("applyInvalidation: action='scheduleOnly' (Step 15)", () => {
  it('does NOT call cancelInFlight and routes to deps.scheduleOnly', async () => {
    const scheduleOnly = vi.fn(async () => []);
    const deps = makeDeps({ scheduleOnly });
    const out = await applyInvalidation('task', 'scheduleOnly', 'task-a', deps);
    expect(out).toEqual([]);
    expect(deps.cancelInFlight).not.toHaveBeenCalled();
    expect(scheduleOnly).toHaveBeenCalledWith('task-a');
  });

  it('returns the started tasks from deps.scheduleOnly verbatim', async () => {
    const fakeTasks = [{ id: 'task-a' } as never, { id: 'task-b' } as never];
    const scheduleOnly = vi.fn(async () => fakeTasks);
    const deps = makeDeps({ scheduleOnly });
    const out = await applyInvalidation('task', 'scheduleOnly', 'task-a', deps);
    expect(out).toBe(fakeTasks);
    expect(deps.cancelInFlight).not.toHaveBeenCalled();
  });

  it('rejects workflow-scoped invocation with scheduleOnly action', async () => {
    const scheduleOnly = vi.fn(async () => []);
    const deps = makeDeps({ scheduleOnly });
    await expect(
      applyInvalidation('workflow', 'scheduleOnly', 'wf-1', deps),
    ).rejects.toThrow(/requires scope 'task'/);
    expect(deps.cancelInFlight).not.toHaveBeenCalled();
    expect(scheduleOnly).not.toHaveBeenCalled();
  });

  it('rejects scope=none with scheduleOnly action', async () => {
    const scheduleOnly = vi.fn(async () => []);
    const deps = makeDeps({ scheduleOnly });
    await expect(
      applyInvalidation('none', 'scheduleOnly', 'task-a', deps),
    ).rejects.toThrow(/requires scope 'task'/);
    expect(deps.cancelInFlight).not.toHaveBeenCalled();
    expect(scheduleOnly).not.toHaveBeenCalled();
  });

  it('throws an explicit missing-dep error when scheduleOnly dep is absent', async () => {
    const deps = makeDeps();
    await expect(
      applyInvalidation('task', 'scheduleOnly', 'task-a', deps),
    ).rejects.toThrow(/'scheduleOnly' dep is missing/);
    expect(deps.cancelInFlight).not.toHaveBeenCalled();
  });

  it('does not call any retry/recreate/fork lifecycle dep', async () => {
    const scheduleOnly = vi.fn(async () => []);
    const recreateWorkflowFromFreshBase = vi.fn(async () => []);
    const workflowFork = vi.fn(async () => []);
    const deps = makeDeps({ scheduleOnly, recreateWorkflowFromFreshBase, workflowFork });
    await applyInvalidation('task', 'scheduleOnly', 'task-a', deps);
    expect(deps.retryTask).not.toHaveBeenCalled();
    expect(deps.recreateTask).not.toHaveBeenCalled();
    expect(deps.retryWorkflow).not.toHaveBeenCalled();
    expect(deps.recreateWorkflow).not.toHaveBeenCalled();
    expect(recreateWorkflowFromFreshBase).not.toHaveBeenCalled();
    expect(workflowFork).not.toHaveBeenCalled();
  });
});

// Cross-workflow cascade matrix. Every invalidating action MUST
// invoke `deps.cascadeDownstream(scope, id)` AFTER the lifecycle dep
// returns and AFTER `cancelInFlight`. Non-invalidating actions
// (`'none'`, `'scheduleOnly'`, `'fixApprove'`, `'fixReject'`) MUST
// NOT invoke the cascade.
describe('applyInvalidation: cascadeDownstream (cross-workflow cascade)', () => {
  it('calls cascadeDownstream after retryTask', async () => {
    const cascadeDownstream = vi.fn(async () => []);
    const deps = makeDeps({ cascadeDownstream });
    await applyInvalidation('task', 'retryTask', 'task-a', deps);
    expect(cascadeDownstream).toHaveBeenCalledWith('task', 'task-a');
    expect(deps.retryTask.mock.invocationCallOrder[0]).toBeLessThan(
      cascadeDownstream.mock.invocationCallOrder[0],
    );
  });

  it('calls cascadeDownstream after recreateTask', async () => {
    const cascadeDownstream = vi.fn(async () => []);
    const deps = makeDeps({ cascadeDownstream });
    await applyInvalidation('task', 'recreateTask', 'task-a', deps);
    expect(cascadeDownstream).toHaveBeenCalledWith('task', 'task-a');
    expect(deps.recreateTask.mock.invocationCallOrder[0]).toBeLessThan(
      cascadeDownstream.mock.invocationCallOrder[0],
    );
  });

  it('calls cascadeDownstream after retryWorkflow', async () => {
    const cascadeDownstream = vi.fn(async () => []);
    const deps = makeDeps({ cascadeDownstream });
    await applyInvalidation('workflow', 'retryWorkflow', 'wf-1', deps);
    expect(cascadeDownstream).toHaveBeenCalledWith('workflow', 'wf-1');
    expect(deps.retryWorkflow.mock.invocationCallOrder[0]).toBeLessThan(
      cascadeDownstream.mock.invocationCallOrder[0],
    );
  });

  it('calls cascadeDownstream after recreateWorkflow', async () => {
    const cascadeDownstream = vi.fn(async () => []);
    const deps = makeDeps({ cascadeDownstream });
    await applyInvalidation('workflow', 'recreateWorkflow', 'wf-1', deps);
    expect(cascadeDownstream).toHaveBeenCalledWith('workflow', 'wf-1');
    expect(deps.recreateWorkflow.mock.invocationCallOrder[0]).toBeLessThan(
      cascadeDownstream.mock.invocationCallOrder[0],
    );
  });

  it('calls cascadeDownstream after recreateWorkflowFromFreshBase', async () => {
    const cascadeDownstream = vi.fn(async () => []);
    const recreateWorkflowFromFreshBase = vi.fn(async () => []);
    const deps = makeDeps({ cascadeDownstream, recreateWorkflowFromFreshBase });
    await applyInvalidation('workflow', 'recreateWorkflowFromFreshBase', 'wf-1', deps);
    expect(cascadeDownstream).toHaveBeenCalledWith('workflow', 'wf-1');
    expect(recreateWorkflowFromFreshBase.mock.invocationCallOrder[0]).toBeLessThan(
      cascadeDownstream.mock.invocationCallOrder[0],
    );
  });

  it('calls cascadeDownstream after workflowFork', async () => {
    const cascadeDownstream = vi.fn(async () => []);
    const workflowFork = vi.fn(async () => []);
    const deps = makeDeps({ cascadeDownstream, workflowFork });
    await applyInvalidation('workflow', 'workflowFork', 'wf-1', deps);
    expect(cascadeDownstream).toHaveBeenCalledWith('workflow', 'wf-1');
    expect(workflowFork.mock.invocationCallOrder[0]).toBeLessThan(
      cascadeDownstream.mock.invocationCallOrder[0],
    );
  });

  it("does NOT call cascadeDownstream for action 'none'", async () => {
    const cascadeDownstream = vi.fn(async () => []);
    const deps = makeDeps({ cascadeDownstream });
    await applyInvalidation('none', 'none', 'task-a', deps);
    expect(cascadeDownstream).not.toHaveBeenCalled();
  });

  it("does NOT call cascadeDownstream for action 'scheduleOnly'", async () => {
    const cascadeDownstream = vi.fn(async () => []);
    const scheduleOnly = vi.fn(async () => []);
    const deps = makeDeps({ cascadeDownstream, scheduleOnly });
    await applyInvalidation('task', 'scheduleOnly', 'task-a', deps);
    expect(cascadeDownstream).not.toHaveBeenCalled();
  });

  it("does NOT call cascadeDownstream for action 'fixApprove'", async () => {
    const cascadeDownstream = vi.fn(async () => []);
    const fixApprove = vi.fn(async () => []);
    const deps = makeDeps({ cascadeDownstream, fixApprove });
    await applyInvalidation('task', 'fixApprove', 'task-a', deps);
    expect(cascadeDownstream).not.toHaveBeenCalled();
  });

  it("does NOT call cascadeDownstream for action 'fixReject'", async () => {
    const cascadeDownstream = vi.fn(async () => []);
    const fixReject = vi.fn(async () => []);
    const deps = makeDeps({ cascadeDownstream, fixReject });
    await applyInvalidation('task', 'fixReject', 'task-a', deps);
    expect(cascadeDownstream).not.toHaveBeenCalled();
  });

  it('cascadeDownstream is optional — missing dep does not break invalidating actions', async () => {
    const deps = makeDeps();
    expect(deps.cascadeDownstream).toBeUndefined();
    await expect(
      applyInvalidation('workflow', 'recreateWorkflow', 'wf-1', deps),
    ).resolves.toBeDefined();
    expect(deps.recreateWorkflow).toHaveBeenCalledWith('wf-1');
  });

  it('cascadeDownstream is awaited (sequencing lock-in)', async () => {
    const events: string[] = [];
    const cascadeDownstream = vi.fn(async () => {
      events.push('cascade-start');
      await new Promise((r) => setTimeout(r, 1));
      events.push('cascade-end');
      return [];
    });
    const recreateWorkflow = vi.fn(async () => {
      events.push('recreate');
      return [];
    });
    const deps = makeDeps({ cascadeDownstream, recreateWorkflow });
    await applyInvalidation('workflow', 'recreateWorkflow', 'wf-1', deps);
    expect(events).toEqual(['recreate', 'cascade-start', 'cascade-end']);
  });

  it('returns the lifecycle dep result, not the cascade result', async () => {
    const lifecycleResult = [{ id: 'task-a' } as never];
    const cascadeResult = [{ id: 'cascade-a' } as never];
    const cascadeDownstream = vi.fn(async () => cascadeResult);
    const recreateWorkflow = vi.fn(async () => lifecycleResult);
    const deps = makeDeps({ cascadeDownstream, recreateWorkflow });
    const out = await applyInvalidation('workflow', 'recreateWorkflow', 'wf-1', deps);
    expect(out).toBe(lifecycleResult);
  });
});

// Property tests over `ACTION_SPECS`: adding a new
// `InvalidationAction` or a new pipeline stage must preserve these
// invariants.

const ALL_INVALIDATION_ACTIONS: readonly InvalidationAction[] = [
  'none',
  'scheduleOnly',
  'fixApprove',
  'fixReject',
  'retryTask',
  'recreateTask',
  'recreateDownstream',
  'retryWorkflow',
  'recreateWorkflow',
  'recreateWorkflowFromFreshBase',
  'workflowFork',
] as const;

const INVALIDATING_ACTIONS: readonly InvalidationAction[] = [
  'retryTask',
  'recreateTask',
  'recreateDownstream',
  'retryWorkflow',
  'recreateWorkflow',
  'recreateWorkflowFromFreshBase',
  'workflowFork',
] as const;

describe('ACTION_SPECS pipeline invariants', () => {
  it('exhaustiveness: every InvalidationAction has an ActionSpec', () => {
    for (const action of ALL_INVALIDATION_ACTIONS) {
      expect(ACTION_SPECS[action], `missing ACTION_SPECS entry for '${action}'`).toBeDefined();
      expect(ACTION_SPECS[action].stages.length, `'${action}' must declare at least one stage`).toBeGreaterThan(0);
    }
  });

  it("cancel-first invariant: 'cancelInFlight' (when present) precedes 'applyPrimitive'", () => {
    for (const action of ALL_INVALIDATION_ACTIONS) {
      const stages = ACTION_SPECS[action].stages;
      const cancelIdx = stages.indexOf('cancelInFlight');
      const applyIdx = stages.indexOf('applyPrimitive');
      if (cancelIdx === -1) continue; // action skips cancel — fine
      expect(applyIdx, `'${action}' has cancelInFlight but no applyPrimitive`).toBeGreaterThan(-1);
      expect(
        cancelIdx,
        `'${action}' must run cancelInFlight before applyPrimitive (got cancelInFlight at ${cancelIdx}, applyPrimitive at ${applyIdx})`,
      ).toBeLessThan(applyIdx);
    }
  });

  it("cascade-completeness: cascadesAcrossWorkflows iff stages.includes('cascadeAcrossWorkflows')", () => {
    for (const action of ALL_INVALIDATION_ACTIONS) {
      const spec = ACTION_SPECS[action];
      const hasCascadeStage = spec.stages.includes('cascadeAcrossWorkflows');
      expect(
        spec.cascadesAcrossWorkflows,
        `'${action}': cascadesAcrossWorkflows=${spec.cascadesAcrossWorkflows} but stages.includes('cascadeAcrossWorkflows')=${hasCascadeStage}`,
      ).toBe(hasCascadeStage);
    }
  });

  it('cascade-completeness: every chart-mandated invalidating action cascades', () => {
    for (const action of INVALIDATING_ACTIONS) {
      expect(
        ACTION_SPECS[action].cascadesAcrossWorkflows,
        `invalidating action '${action}' must cascade across workflows`,
      ).toBe(true);
    }
  });

  it("policy-table consistency: every MUTATION_POLICIES[k].action is a key of ACTION_SPECS", () => {
    for (const [mutationKey, policy] of Object.entries(MUTATION_POLICIES)) {
      expect(
        ACTION_SPECS[policy.action],
        `MUTATION_POLICIES.${mutationKey}.action='${policy.action}' has no ActionSpec`,
      ).toBeDefined();
    }
  });
});
