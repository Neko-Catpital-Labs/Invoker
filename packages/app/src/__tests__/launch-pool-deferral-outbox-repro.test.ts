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
    launchOutboxMode: 'active',
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
        expect(dispatchOpts.launchOutbox.ackDispatch(dispatchOpts.dispatchId, 'pool-runner')).toBe(true);
        const attemptId = task.execution.selectedAttemptId!;

        if (runnerCalls === 1) {
          persistence.logEvent(task.id, 'task.executor.deferred', {
            reason: 'execution-pool-capacity',
            message: 'Execution pool "pnpm-ssh" has no member capacity available',
            attemptId,
          });
          orchestrator.deferTask(task.id);
          if (options.completeDeferredDispatch) {
            expect(dispatchOpts.launchOutbox.completeDispatch(dispatchOpts.dispatchId)).toBe(true);
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
    mode: 'active',
    maxConcurrency: 1,
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
      .listLaunchDispatchesByState(['enqueued', 'leased', 'acknowledged'])
      .filter((row) => row.taskId === taskId)
      .map((row) => ({ attemptId: row.attemptId, state: row.state })),
    completedRows: persistence
      .listLaunchDispatchesByState(['completed'])
      .filter((row) => row.taskId === taskId)
      .map((row) => ({ attemptId: row.attemptId, state: row.state })),
  };
}

describe('launch pool deferral outbox repro', () => {
  it('proves the root cause: an acknowledged deferred row blocks the replacement launch', async () => {
    const result = await runPoolDeferralScenario({ completeDeferredDispatch: false });

    expect(result.runnerCalls).toBe(1);
    expect(result.task.status).toBe('pending');
    expect(result.task.execution.phase).toBe('launching');
    expect(result.liveRows).toEqual([
      { attemptId: result.firstAttemptId, state: 'acknowledged' },
      { attemptId: result.replacementAttemptId, state: 'enqueued' },
    ]);
  });

  it('proves the fix: completing the deferred row frees capacity for the replacement launch', async () => {
    const result = await runPoolDeferralScenario({ completeDeferredDispatch: true });

    expect(result.runnerCalls).toBe(2);
    expect(result.task.status).toBe('completed');
    expect(result.liveRows).toEqual([]);
    expect(result.completedRows).toEqual([
      { attemptId: result.firstAttemptId, state: 'completed' },
      { attemptId: result.replacementAttemptId, state: 'completed' },
    ]);
  });
});
