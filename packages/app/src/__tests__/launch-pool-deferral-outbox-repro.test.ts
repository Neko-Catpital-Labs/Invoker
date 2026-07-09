import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import type { WorkResponse } from '@invoker/contracts';
import { InMemoryBus } from '@invoker/test-kit';
import { Orchestrator, type PlanDefinition, type TaskState } from '@invoker/workflow-core';
import { LaunchDispatcher } from '../launch-dispatcher.js';

type Harness = {
  dir: string;
  persistence: SQLiteAdapter;
  orchestrator: Orchestrator;
};

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.persistence.close();
    rmSync(harness.dir, { recursive: true, force: true });
  }
});

async function makeHarness(name: string): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), `invoker-${name}-`));
  const persistence = await SQLiteAdapter.create(join(dir, 'invoker-repro.db'), {
    ownerCapability: true,
  });
  const orchestrator = new Orchestrator({
    persistence: persistence as any,
    messageBus: new InMemoryBus(),
    maxConcurrency: 1,
    deferRunningUntilLaunch: true,
  });
  const harness = { dir, persistence, orchestrator };
  harnesses.push(harness);
  return harness;
}

function singleTaskPlan(name: string): PlanDefinition {
  return {
    name,
    baseBranch: 'master',
    featureBranch: `experiment/${name}`,
    onFinish: 'none',
    tasks: [
      {
        id: 'pool-task',
        description: 'pool task',
        command: 'echo pool-task',
      },
    ],
  };
}

function completeResponse(task: TaskState, attemptId: string): WorkResponse {
  return {
    requestId: `req-${task.id}`,
    actionId: task.id,
    attemptId,
    executionGeneration: task.execution.generation ?? 0,
    status: 'completed',
    outputs: { exitCode: 0 },
  };
}

async function flushDispatcherPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function runPoolDeferralScenario(options: { completeDeferredDispatch: boolean }) {
  const { persistence, orchestrator } = await makeHarness(
    options.completeDeferredDispatch ? 'pool-deferral-fixed' : 'pool-deferral-root-cause',
  );
  orchestrator.loadPlan(singleTaskPlan('pool-deferral-outbox-repro'));

  const [firstClaim] = orchestrator.startExecution();
  expect(firstClaim).toBeDefined();
  const taskId = firstClaim!.id;
  const firstAttemptId = firstClaim!.execution.selectedAttemptId!;

  let runnerCalls = 0;
  let deferredCompleteResult: boolean | undefined;
  const dispatcher = new LaunchDispatcher({
    persistence,
    orchestrator: {
      prepareTaskForNewAttempt: (id, reason) => orchestrator.prepareTaskForNewAttempt(id, reason),
      getTask: (id) => orchestrator.getTask(id),
    },
    taskRunnerProvider: () => ({
      async executeTask(task, opts) {
        runnerCalls += 1;
        const dispatchOpts = opts!;
        const attemptId = task.execution.selectedAttemptId!;

        if (runnerCalls === 1) {
          persistence.logEvent(task.id, 'task.executor.deferred', {
            reason: 'execution-pool-capacity',
            message: 'Execution pool "pnpm-ssh" has no member capacity available',
            attemptId,
          });
          orchestrator.deferTask(task.id);
          if (options.completeDeferredDispatch) {
            deferredCompleteResult = dispatchOpts.launchOutbox.completeDispatch(dispatchOpts.dispatchId);
          }
          return;
        }

        expect(orchestrator.markTaskRunningAfterLaunch(task.id, attemptId)).toBe(true);
        expect(dispatchOpts.launchOutbox.completeDispatch(dispatchOpts.dispatchId)).toBe(true);
        const latest = orchestrator.getTask(task.id)!;
        orchestrator.handleWorkerResponse(completeResponse(latest, attemptId));
      },
    }),
    ownerId: 'pool-owner',
    maxLeasesPerPoll: 1,
  });

  dispatcher.poll();
  await flushDispatcherPromises();

  const [replacementClaim] = orchestrator.startExecution();
  expect(replacementClaim).toBeDefined();
  const replacementAttemptId = replacementClaim!.execution.selectedAttemptId!;
  expect(replacementAttemptId).not.toBe(firstAttemptId);

  dispatcher.poll();
  await flushDispatcherPromises();

  return {
    firstAttemptId,
    replacementAttemptId,
    runnerCalls,
    task: orchestrator.getTask(taskId)!,
    liveRows: persistence
      .listLaunchDispatchesByState(['enqueued', 'leased'])
      .filter((row) => row.taskId === taskId)
      .map((row) => ({ attemptId: row.attemptId, state: row.state })),
    abandonedRows: persistence
      .listLaunchDispatchesByState(['abandoned'])
      .filter((row) => row.taskId === taskId)
      .map((row) => ({ attemptId: row.attemptId, state: row.state })),
    completedRows: persistence
      .listLaunchDispatchesByState(['completed'])
      .filter((row) => row.taskId === taskId)
      .map((row) => ({ attemptId: row.attemptId, state: row.state })),
    deferredCompleteResult,
  };
}

describe('launch pool deferral outbox repro', () => {
  it('invalidates a leased deferred row so it cannot block the replacement launch', async () => {
    const result = await runPoolDeferralScenario({ completeDeferredDispatch: false });

    expect(result.runnerCalls).toBe(2);
    expect(result.task.status).toBe('completed');
    expect(result.liveRows).toEqual([]);
    expect(result.abandonedRows).toEqual([
      { attemptId: result.firstAttemptId, state: 'abandoned' },
    ]);
    expect(result.completedRows).toEqual([
      { attemptId: result.replacementAttemptId, state: 'completed' },
    ]);
  });

  it('rejects late completion of an already-invalidated deferred row', async () => {
    const result = await runPoolDeferralScenario({ completeDeferredDispatch: true });

    expect(result.runnerCalls).toBe(2);
    expect(result.task.status).toBe('completed');
    expect(result.liveRows).toEqual([]);
    expect(result.deferredCompleteResult).toBe(false);
    expect(result.abandonedRows).toEqual([
      { attemptId: result.firstAttemptId, state: 'abandoned' },
    ]);
    expect(result.completedRows).toEqual([
      { attemptId: result.replacementAttemptId, state: 'completed' },
    ]);
  });
});
