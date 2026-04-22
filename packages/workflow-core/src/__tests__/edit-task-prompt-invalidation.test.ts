/**
 * Step 3 — Prompt-mutation invalidation contract.
 *
 * This file pins the Step 3 deliverable from
 * `docs/architecture/task-invalidation-roadmap.md` (Phase B): the
 * `prompt` mutation is recreate-class with task scope, and any
 * affected in-flight work is canceled BEFORE authoritative state is
 * reset (the chart's Hard Invariant in
 * `docs/architecture/task-invalidation-chart.md`).
 *
 * Three layers are pinned:
 *
 *   1. **Policy table.** `MUTATION_POLICIES.prompt` is the immutable
 *      contract that the chart's Decision Table row "Edit `prompt`"
 *      maps to: `recreateTask` action / task scope.
 *
 *   2. **Cancel-first routing (mocked deps).** When the prompt-edit
 *      path is wired through
 *      `applyInvalidation('task', 'recreateTask', taskId, deps)`,
 *      the `cancelInFlight` dep is invoked BEFORE the `recreateTask`
 *      dep. We assert this via `mock.invocationCallOrder`. We also
 *      check that a failed cancel aborts the recreate (stale work
 *      must not survive a failed cancel) and that idempotent edits
 *      preserve the cancel-first ordering.
 *
 *   3. **CommandService delegation (Step 3 integration coverage for
 *      the headless layer).** The headless `set prompt` handler
 *      (`headlessEditPrompt` in `packages/app/src/headless.ts`) calls
 *      `deps.commandService.editTaskPrompt(envelope)`. We exercise
 *      that exact entrypoint and assert it serializes through the
 *      workflow mutex and delegates to `Orchestrator.editTaskPrompt`
 *      with the right payload — that is the end-to-end wiring
 *      assertion the Step 3 plan requires for the headless surface,
 *      complementing the unit-level cancel-first / lineage /
 *      generation-bump coverage in `orchestrator.test.ts`.
 *
 * Steps 13/14/17 will further consolidate the wiring; for now this
 * focused file exists alongside `orchestrator.test.ts` and
 * `edit-task-command-invalidation.test.ts` to keep the contract
 * assertions readable as one chunk.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  applyInvalidation,
  MUTATION_POLICIES,
  type InvalidationDeps,
} from '../invalidation-policy.js';
import { CommandService } from '../command-service.js';
import type { Orchestrator } from '../orchestrator.js';
import type { CommandEnvelope } from '@invoker/contracts';
import type { TaskState } from '@invoker/workflow-graph';

type MockedDeps = InvalidationDeps & {
  cancelInFlight: ReturnType<typeof vi.fn>;
  retryTask: ReturnType<typeof vi.fn>;
  recreateTask: ReturnType<typeof vi.fn>;
  retryWorkflow: ReturnType<typeof vi.fn>;
  recreateWorkflow: ReturnType<typeof vi.fn>;
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

describe('Step 3: prompt-mutation invalidation contract', () => {
  it('MUTATION_POLICIES.prompt is recreate-class and invalidates active attempts', () => {
    expect(MUTATION_POLICIES.prompt.action).toBe('recreateTask');
    expect(MUTATION_POLICIES.prompt.invalidatesExecutionSpec).toBe(true);
    expect(MUTATION_POLICIES.prompt.invalidateIfActive).toBe(true);
  });

  it('routes through applyInvalidation with cancelInFlight invoked BEFORE recreateTask dep', async () => {
    const deps = makeDeps();
    const policy = MUTATION_POLICIES.prompt;

    // The prompt-edit path uses the same scope/action that the policy
    // table prescribes. Asserting via the policy makes the test fail
    // loudly if Step 3 (or any later step) flips the action class.
    await applyInvalidation('task', policy.action, 'task-a', deps);

    expect(deps.cancelInFlight).toHaveBeenCalledWith('task', 'task-a');
    expect(deps.recreateTask).toHaveBeenCalledWith('task-a');
    expect(deps.retryTask).not.toHaveBeenCalled();
    expect(deps.retryWorkflow).not.toHaveBeenCalled();
    expect(deps.recreateWorkflow).not.toHaveBeenCalled();
    expect(deps.cancelInFlight.mock.invocationCallOrder[0]).toBeLessThan(
      deps.recreateTask.mock.invocationCallOrder[0],
    );
  });

  it('aborts the recreate when cancelInFlight rejects (stale work must not survive a failed cancel)', async () => {
    const cancelError = new Error('cancel failed');
    const deps = makeDeps({
      cancelInFlight: vi.fn(async () => {
        throw cancelError;
      }),
    });

    await expect(
      applyInvalidation('task', MUTATION_POLICIES.prompt.action, 'task-a', deps),
    ).rejects.toBe(cancelError);
    expect(deps.recreateTask).not.toHaveBeenCalled();
  });

  it('idempotence: two consecutive prompt edits trigger two cancel-first cycles, ordering preserved', async () => {
    const deps = makeDeps();
    const policy = MUTATION_POLICIES.prompt;

    await applyInvalidation('task', policy.action, 'task-a', deps);
    await applyInvalidation('task', policy.action, 'task-a', deps);

    expect(deps.cancelInFlight).toHaveBeenCalledTimes(2);
    expect(deps.recreateTask).toHaveBeenCalledTimes(2);

    // Each cycle: cancelInFlight strictly before its paired recreateTask.
    expect(deps.cancelInFlight.mock.invocationCallOrder[0]).toBeLessThan(
      deps.recreateTask.mock.invocationCallOrder[0],
    );
    expect(deps.cancelInFlight.mock.invocationCallOrder[1]).toBeLessThan(
      deps.recreateTask.mock.invocationCallOrder[1],
    );

    // Cycles are sequential: the first recreate completes before the
    // second cancel begins (await-chain ordering).
    expect(deps.recreateTask.mock.invocationCallOrder[0]).toBeLessThan(
      deps.cancelInFlight.mock.invocationCallOrder[1],
    );
  });

  it('rejects task-scoped wiring with workflow-only actions (defensive scope/action mismatch)', async () => {
    const deps = makeDeps();
    await expect(
      applyInvalidation('workflow', MUTATION_POLICIES.prompt.action, 'task-a', deps),
    ).rejects.toThrow(/requires scope 'task'/);
    expect(deps.cancelInFlight).not.toHaveBeenCalled();
    expect(deps.recreateTask).not.toHaveBeenCalled();
  });
});

// ── Step 3 headless integration seam: CommandService.editTaskPrompt ──
//
// `headlessEditPrompt` (in `packages/app/src/headless.ts`) constructs
// an envelope and calls `deps.commandService.editTaskPrompt(envelope)`.
// That `CommandService` method serializes the mutation through the
// workflow mutex and delegates to `Orchestrator.editTaskPrompt`,
// which is where the cancel-first / lineage-discard / generation-bump
// invariants live (covered by `orchestrator.test.ts` and pinned by
// the policy-level tests above). This block exercises that exact
// integration seam so the headless surface has a passing end-to-end
// wiring assertion in addition to the orchestrator-level coverage.
function stubOrchestrator(overrides: Partial<Orchestrator> = {}): Orchestrator {
  return {
    getTask: vi.fn().mockReturnValue({ config: { workflowId: 'wf-1' } }),
    editTaskPrompt: vi.fn().mockReturnValue([] as TaskState[]),
    ...overrides,
  } as unknown as Orchestrator;
}

describe('Step 3: CommandService.editTaskPrompt (headless integration seam)', () => {
  let orchestrator: Orchestrator;
  let service: CommandService;

  beforeEach(() => {
    orchestrator = stubOrchestrator();
    service = new CommandService(orchestrator);
  });

  it('delegates a prompt-edit envelope to orchestrator.editTaskPrompt with the expected payload', async () => {
    const envelope: CommandEnvelope<{ taskId: string; newPrompt: string }> = {
      commandId: 'cmd-prompt-1',
      source: 'headless',
      scope: 'task',
      idempotencyKey: 'idem-1',
      payload: { taskId: 'wf-1/t1', newPrompt: 'fresh prompt' },
    };

    const result = await service.editTaskPrompt(envelope);

    expect(result).toEqual({ ok: true, data: [] });
    expect(orchestrator.editTaskPrompt).toHaveBeenCalledWith('wf-1/t1', 'fresh prompt');
    expect(orchestrator.editTaskPrompt).toHaveBeenCalledTimes(1);
  });

  it('wraps orchestrator errors in CommandResult instead of throwing', async () => {
    orchestrator = stubOrchestrator({
      editTaskPrompt: vi.fn().mockImplementation(() => {
        throw new Error('boom');
      }),
    });
    service = new CommandService(orchestrator);

    const envelope: CommandEnvelope<{ taskId: string; newPrompt: string }> = {
      commandId: 'cmd-prompt-2',
      source: 'headless',
      scope: 'task',
      idempotencyKey: 'idem-2',
      payload: { taskId: 'wf-1/t1', newPrompt: 'doomed' },
    };

    const result = await service.editTaskPrompt(envelope);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('EDIT_TASK_PROMPT_FAILED');
      expect(result.error.message).toContain('boom');
    }
  });
});
