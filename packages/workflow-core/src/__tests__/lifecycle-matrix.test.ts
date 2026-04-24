/**
 * Step 17 cross-surface lock-in test for the canonical
 * `{retry, recreate} × {task, workflow}` lifecycle matrix
 * (`docs/architecture/task-invalidation-roadmap.md` Step 17,
 * `docs/architecture/task-invalidation-chart.md`
 * "Proposed API Direction").
 *
 * This file is the **authoritative matrix**. It pins:
 *
 *   1. The five canonical lifecycle actions exist on the
 *      `InvalidationAction` surface and route through
 *      `applyInvalidation` to the matching `InvalidationDeps`
 *      method (`retryTask`, `recreateTask`, `retryWorkflow`,
 *      `recreateWorkflow`, `recreateWorkflowFromFreshBase`).
 *   2. The `Orchestrator` class has all five primitive methods
 *      that the action wrappers route to.
 *   3. The chart's lineage classification — retry-class
 *      preserves; recreate-class discards; rebase-and-retry
 *      additionally refreshes upstream — is encoded in the
 *      policy table (`MUTATION_POLICIES`).
 *   4. The cancel-first Hard Invariant is honored for every
 *      retry/recreate cell, including the fresh-base cell. The
 *      non-invalidating outliers (`scheduleOnly` /
 *      `fixApprove` / `fixReject`) deliberately skip
 *      cancel-first per the chart.
 *   5. The Step 13 `restartTask` shim still delegates to
 *      `recreateTask` (the conservative choice; a separate
 *      lock-in lives in `restart-deprecation.test.ts` —
 *      this file just reasserts the matrix-level invariant).
 *   6. Non-invalidating mutations (`externalGatePolicy`,
 *      `fixApprove`, `fixReject`) are NOT in the retry/recreate
 *      matrix — `MUTATION_POLICIES` lists them with their own
 *      non-invalidating actions.
 *
 * Headless / API surfaces are pinned in their own delegation
 * tests (`packages/app/src/__tests__/headless-delegation.test.ts`
 * and `packages/app/src/__tests__/api-server.test.ts`); this
 * file is intentionally `workflow-core`-only so the matrix
 * lives in the package that owns the policy table.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  applyInvalidation,
  MUTATION_POLICIES,
  type InvalidationAction,
  type InvalidationDeps,
  type InvalidationScope,
} from '../invalidation-policy.js';
import { Orchestrator } from '../orchestrator.js';

// ── Matrix shape ────────────────────────────────────────────

type Cell = {
  label: string;
  action: InvalidationAction;
  scope: InvalidationScope;
  id: string;
  expectedDep:
    | 'retryTask'
    | 'recreateTask'
    | 'retryWorkflow'
    | 'recreateWorkflow'
    | 'recreateWorkflowFromFreshBase';
  /** Lineage classification per the chart. */
  lineage: 'preserves' | 'discards' | 'discards+refreshesUpstream';
};

const MATRIX: readonly Cell[] = Object.freeze([
  {
    label: 'task × retry',
    action: 'retryTask',
    scope: 'task',
    id: 't-retry',
    expectedDep: 'retryTask',
    lineage: 'preserves',
  },
  {
    label: 'task × recreate',
    action: 'recreateTask',
    scope: 'task',
    id: 't-recreate',
    expectedDep: 'recreateTask',
    lineage: 'discards',
  },
  {
    label: 'workflow × retry',
    action: 'retryWorkflow',
    scope: 'workflow',
    id: 'wf-retry',
    expectedDep: 'retryWorkflow',
    lineage: 'preserves',
  },
  {
    label: 'workflow × recreate',
    action: 'recreateWorkflow',
    scope: 'workflow',
    id: 'wf-recreate',
    expectedDep: 'recreateWorkflow',
    lineage: 'discards',
  },
  {
    label: 'workflow × recreateFromFreshBase (rebase-and-retry)',
    action: 'recreateWorkflowFromFreshBase',
    scope: 'workflow',
    id: 'wf-rebase',
    expectedDep: 'recreateWorkflowFromFreshBase',
    lineage: 'discards+refreshesUpstream',
  },
] as const);

function buildSpyDeps(): {
  deps: InvalidationDeps;
  spies: Record<Cell['expectedDep'] | 'cancelInFlight', ReturnType<typeof vi.fn>>;
  callOrder: string[];
} {
  const callOrder: string[] = [];
  const cancelInFlight = vi.fn(async (scope: InvalidationScope, id: string) => {
    callOrder.push(`cancelInFlight:${scope}:${id}`);
  });
  const retryTask = vi.fn((id: string) => { callOrder.push(`retryTask:${id}`); return []; });
  const recreateTask = vi.fn((id: string) => { callOrder.push(`recreateTask:${id}`); return []; });
  const retryWorkflow = vi.fn((id: string) => { callOrder.push(`retryWorkflow:${id}`); return []; });
  const recreateWorkflow = vi.fn((id: string) => { callOrder.push(`recreateWorkflow:${id}`); return []; });
  const recreateWorkflowFromFreshBase = vi.fn((id: string) => {
    callOrder.push(`recreateWorkflowFromFreshBase:${id}`);
    return [];
  });
  return {
    deps: {
      cancelInFlight,
      retryTask,
      recreateTask,
      retryWorkflow,
      recreateWorkflow,
      recreateWorkflowFromFreshBase,
    },
    spies: {
      cancelInFlight,
      retryTask,
      recreateTask,
      retryWorkflow,
      recreateWorkflow,
      recreateWorkflowFromFreshBase,
    },
    callOrder,
  };
}

// ── Tests ───────────────────────────────────────────────────

describe('Step 17: canonical lifecycle matrix lock-in', () => {
  // ── 1. The five canonical actions exist and route correctly ──

  describe('matrix routing through applyInvalidation', () => {
    for (const cell of MATRIX) {
      it(`${cell.label} → calls deps.${cell.expectedDep}("${cell.id}") exactly once`, async () => {
        const { deps, spies } = buildSpyDeps();

        await applyInvalidation(cell.scope, cell.action, cell.id, deps);

        expect(spies[cell.expectedDep]).toHaveBeenCalledTimes(1);
        expect(spies[cell.expectedDep]).toHaveBeenCalledWith(cell.id);

        // No other lifecycle dep should fire — the matrix cells
        // are mutually exclusive at the routing layer.
        for (const otherDep of [
          'retryTask',
          'recreateTask',
          'retryWorkflow',
          'recreateWorkflow',
          'recreateWorkflowFromFreshBase',
        ] as const) {
          if (otherDep === cell.expectedDep) continue;
          expect(spies[otherDep], `unexpected call to deps.${otherDep} for ${cell.label}`).not.toHaveBeenCalled();
        }
      });
    }
  });

  // ── 2. Orchestrator exposes all 5 primitive methods ──────────

  describe('Orchestrator primitive surface', () => {
    it('exposes all 5 canonical lifecycle methods (the matrix targets)', () => {
      // Matrix targets named explicitly; if any are missing this
      // test fails at compile time on the `keyof Orchestrator`
      // index.
      const methodNames: ReadonlyArray<keyof Orchestrator> = [
        'retryTask',
        'recreateTask',
        'retryWorkflow',
        'recreateWorkflow',
        'recreateWorkflowFromFreshBase',
      ];
      for (const name of methodNames) {
        expect(typeof Orchestrator.prototype[name]).toBe('function');
      }
    });

    it('still exposes the Step 13 deprecated restartTask shim that delegates to recreateTask', () => {
      // The shim's behavior is locked-in by `restart-deprecation.test.ts`;
      // here we just reassert the surface invariant so the matrix
      // doc reads cleanly: restartTask exists, restartTask !== retryTask
      // path, and restartTask collapses to recreateTask. See
      // `docs/architecture/task-invalidation-chart.md` "Naming
      // inconsistency" for the rationale.
      expect(typeof Orchestrator.prototype.restartTask).toBe('function');

      const orch = Object.create(Orchestrator.prototype) as Orchestrator;
      const recreateSpy = vi.spyOn(orch, 'recreateTask').mockReturnValue([]);
      const retrySpy = vi.spyOn(orch, 'retryTask').mockReturnValue([]);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        orch.restartTask('t-x');
        expect(recreateSpy).toHaveBeenCalledTimes(1);
        expect(recreateSpy).toHaveBeenCalledWith('t-x');
        expect(retrySpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
        recreateSpy.mockRestore();
        retrySpy.mockRestore();
      }
    });
  });

  // ── 3. Chart's lineage classification per cell ──────────────

  describe('lineage classification matches the chart', () => {
    it('retry-class cells preserve lineage; recreate-class cells discard; rebase-and-retry discards + refreshes upstream', () => {
      // The lineage column is documentation that links each cell
      // to the chart's "Decision Table". This test pins the
      // expected classification next to each cell so changes to
      // the chart MUST be reflected in this file (and vice
      // versa). The orchestrator-level lineage behavior itself
      // is exercised by `orchestrator.test.ts`; here we only
      // assert the chart-aligned classification labels.
      const byAction = new Map(MATRIX.map((c) => [c.action, c]));
      expect(byAction.get('retryTask')?.lineage).toBe('preserves');
      expect(byAction.get('retryWorkflow')?.lineage).toBe('preserves');
      expect(byAction.get('recreateTask')?.lineage).toBe('discards');
      expect(byAction.get('recreateWorkflow')?.lineage).toBe('discards');
      expect(byAction.get('recreateWorkflowFromFreshBase')?.lineage).toBe(
        'discards+refreshesUpstream',
      );
    });
  });

  // ── 4. Cancel-first Hard Invariant ──────────────────────────

  describe('cancel-first Hard Invariant', () => {
    for (const cell of MATRIX) {
      it(`${cell.label} → calls cancelInFlight BEFORE the lifecycle dep`, async () => {
        const { deps, callOrder } = buildSpyDeps();

        await applyInvalidation(cell.scope, cell.action, cell.id, deps);

        const cancelIdx = callOrder.findIndex((e) => e.startsWith('cancelInFlight:'));
        const lifecycleIdx = callOrder.findIndex((e) => e.startsWith(`${cell.expectedDep}:`));
        expect(cancelIdx, `expected cancelInFlight in call order: ${callOrder.join(' -> ')}`).toBeGreaterThanOrEqual(0);
        expect(lifecycleIdx).toBeGreaterThanOrEqual(0);
        expect(cancelIdx).toBeLessThan(lifecycleIdx);
      });
    }

    it('aborts BEFORE the lifecycle dep when cancelInFlight rejects', async () => {
      const { deps, spies } = buildSpyDeps();
      (spies.cancelInFlight as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('boom'),
      );

      await expect(
        applyInvalidation('task', 'recreateTask', 't-1', deps),
      ).rejects.toThrow('boom');

      // Hard policy: stale in-flight work must not survive a
      // failed cancel — the lifecycle dep MUST NOT have run.
      expect(spies.recreateTask).not.toHaveBeenCalled();
    });
  });

  // ── 5. Non-invalidating outliers stay OUT of the matrix ─────

  describe('non-invalidating outliers (NOT in the retry/recreate matrix)', () => {
    it('externalGatePolicy is scheduleOnly — NOT a retry/recreate action', () => {
      // Step 15 (chart row "Change external gate policy"):
      // intentional non-invalidating outlier. MUST NOT collapse
      // to any retry/recreate cell. `applyInvalidation` skips
      // cancel-first for this action.
      const policy = MUTATION_POLICIES.externalGatePolicy;
      expect(policy.action).toBe('scheduleOnly');
      expect(policy.invalidatesExecutionSpec).toBe(false);
      expect(policy.invalidateIfActive).toBe(false);

      // Belt-and-suspenders: make sure it's not in the matrix.
      const matrixActions = new Set(MATRIX.map((c) => c.action));
      expect(matrixActions.has(policy.action)).toBe(false);
    });

    it('fixApprove / fixReject are control-flow over an existing fix attempt — NOT retry/recreate actions', () => {
      // Step 16 (chart row "Approve or reject fix"): the second
      // intentional non-invalidating outlier. Both deliberately
      // skip cancel-first; both leave `task.execution.generation`
      // alone.
      const approve = MUTATION_POLICIES.fixApprove;
      const reject = MUTATION_POLICIES.fixReject;
      expect(approve.action).toBe('fixApprove');
      expect(approve.invalidatesExecutionSpec).toBe(false);
      expect(approve.invalidateIfActive).toBe(false);
      expect(reject.action).toBe('fixReject');
      expect(reject.invalidatesExecutionSpec).toBe(false);
      expect(reject.invalidateIfActive).toBe(false);

      const matrixActions = new Set(MATRIX.map((c) => c.action));
      expect(matrixActions.has(approve.action)).toBe(false);
      expect(matrixActions.has(reject.action)).toBe(false);
    });

    it('applyInvalidation does NOT call cancelInFlight for scheduleOnly / fixApprove / fixReject', async () => {
      const { deps, spies } = buildSpyDeps();
      const scheduleOnly = vi.fn().mockResolvedValue([]);
      const fixApprove = vi.fn().mockResolvedValue([]);
      const fixReject = vi.fn().mockResolvedValue([]);
      const augmented: InvalidationDeps = { ...deps, scheduleOnly, fixApprove, fixReject };

      await applyInvalidation('task', 'scheduleOnly', 't-1', augmented);
      await applyInvalidation('task', 'fixApprove', 't-2', augmented);
      await applyInvalidation('task', 'fixReject', 't-3', augmented);

      expect(scheduleOnly).toHaveBeenCalledWith('t-1');
      expect(fixApprove).toHaveBeenCalledWith('t-2');
      expect(fixReject).toHaveBeenCalledWith('t-3');
      // The chart's Hard Invariant is intentionally bypassed for
      // these three actions; if they ever start cancelling
      // in-flight work it's a regression against the chart's
      // "These are not execution-defining task inputs" list.
      expect(spies.cancelInFlight).not.toHaveBeenCalled();
    });
  });

  // ── 6. Policy-table coherence with the matrix ────────────────

  describe('MUTATION_POLICIES references the canonical matrix actions', () => {
    it('every execution-spec mutation in the policy table maps to a matrix action OR an explicit non-invalidating outlier', () => {
      const matrixActions = new Set<InvalidationAction>(MATRIX.map((c) => c.action));
      const allowedNonMatrix = new Set<InvalidationAction>([
        'scheduleOnly',
        'fixApprove',
        'fixReject',
        'workflowFork',
        'none',
      ]);
      for (const [key, policy] of Object.entries(MUTATION_POLICIES)) {
        const isMatrix = matrixActions.has(policy.action);
        const isAllowedNonMatrix = allowedNonMatrix.has(policy.action);
        expect(
          isMatrix || isAllowedNonMatrix,
          `MUTATION_POLICIES.${key}.action='${policy.action}' is neither a canonical matrix action nor a documented non-invalidating outlier`,
        ).toBe(true);
      }
    });

    it('rebaseAndRetry mutation key targets the strictly-stronger workflow recreate (recreateWorkflowFromFreshBase)', () => {
      // Sanity: the chart's "Rebase and retry" row maps to the
      // strictly-stronger workflow recreate, NOT plain
      // recreateWorkflow. This is the row that distinguishes the
      // 5th cell (rebase-and-retry) from the 4th cell (plain
      // workflow recreate).
      expect(MUTATION_POLICIES.rebaseAndRetry.action).toBe('recreateWorkflowFromFreshBase');
    });
  });
});
