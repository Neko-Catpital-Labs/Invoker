import { describe, it, expect } from 'vitest';
import type { Orchestrator } from '../orchestrator.js';
import {
  InMemoryPersistence,
  makeOrchestrator,
  makeResponse,
} from './helpers/cross-workflow-cascade-helpers.js';

interface Slice {
  wfId: string;
  rootId: string;
  mergeId: string;
}

interface StackContext {
  a: Slice;
  b: Slice;
  c: Slice;
}

function loadSlice(
  orchestrator: Orchestrator,
  name: string,
  baseBranch: string,
  upstreamWfId?: string,
): Slice {
  const before = new Set(orchestrator.getAllTasks().map((t) => t.config.workflowId));
  orchestrator.loadPlan({
    name,
    baseBranch,
    featureBranch: `plan/${name}`,
    tasks: [
      {
        id: 'root',
        description: `${name} root`,
        ...(upstreamWfId
          ? { externalDependencies: [{ workflowId: upstreamWfId, gatePolicy: 'review_ready' as const }] }
          : {}),
      },
      { id: 'verify', description: `${name} verify`, dependencies: ['root'] },
    ],
  });
  const wfId = orchestrator.getAllTasks()
    .map((t) => t.config.workflowId)
    .find((id) => !before.has(id))!;
  return { wfId, rootId: `${wfId}/root`, mergeId: `__merge__${wfId}` };
}

function setupStack(orchestrator: Orchestrator): StackContext {
  const a = loadSlice(orchestrator, 'slice-1', 'master');
  const b = loadSlice(orchestrator, 'slice-2', 'plan/slice-1', a.wfId);
  const c = loadSlice(orchestrator, 'slice-3', 'plan/slice-2', b.wfId);
  orchestrator.startExecution();
  expect(orchestrator.getTask(a.rootId)!.status).toBe('running');
  expect(orchestrator.getTask(b.rootId)!.status).toBe('pending');
  expect(orchestrator.getTask(c.rootId)!.status).toBe('pending');
  return { a, b, c };
}

function workflowTaskStatuses(orchestrator: Orchestrator, wfId: string): Record<string, string> {
  return Object.fromEntries(
    orchestrator.getAllTasks()
      .filter((t) => t.config.workflowId === wfId)
      .map((t) => [t.id, t.status]),
  );
}

describe('REPRO 2026-09-01: cancelling slice 1 of a chained stack rewrote slices 2-4 onto master and launched them', () => {
  it('keeps downstream base branch and external dependency intact after upstream cancel', () => {
    const persistence = new InMemoryPersistence();
    const orchestrator = makeOrchestrator(persistence);
    const { a, b, c } = setupStack(orchestrator);

    orchestrator.handleWorkerResponse(makeResponse({ actionId: a.rootId, status: 'failed' }));
    orchestrator.cancelWorkflow(a.wfId);

    const bRecord = persistence.loadWorkflow(b.wfId)!;
    expect(bRecord.baseBranch).toBe('plan/slice-1');
    expect(bRecord.externalDependencies).toEqual([
      { workflowId: a.wfId, taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'review_ready' },
    ]);
    expect(bRecord.detachedExternalDependencies).toBeUndefined();

    const cRecord = persistence.loadWorkflow(c.wfId)!;
    expect(cRecord.baseBranch).toBe('plan/slice-2');
    expect(cRecord.externalDependencies).toEqual([
      { workflowId: b.wfId, taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'review_ready' },
    ]);
    expect(cRecord.detachedExternalDependencies).toBeUndefined();

    const ready = orchestrator.getExecutableReadyTasks().map((t) => t.id);
    expect(ready).not.toContain(b.rootId);
    expect(ready).not.toContain(c.rootId);
  });

  it('cancels every never-started downstream task instead of leaving it pending forever', () => {
    const persistence = new InMemoryPersistence();
    const orchestrator = makeOrchestrator(persistence);
    const { a, b, c } = setupStack(orchestrator);

    orchestrator.cancelWorkflow(a.wfId);

    for (const wfId of [b.wfId, c.wfId]) {
      const statuses = Object.values(workflowTaskStatuses(orchestrator, wfId));
      expect(statuses, `all tasks of ${wfId} must be cancelled`).not.toContain('pending');
      expect(statuses).not.toContain('running');
    }
    expect(orchestrator.getTask(b.rootId)!.execution.error).toContain(a.wfId);
    expect(orchestrator.getTask(c.rootId)!.execution.error).toContain(a.wfId);
  });

  it('does not resurrect a downstream slice that was already cancelled tail-first', () => {
    const persistence = new InMemoryPersistence();
    const orchestrator = makeOrchestrator(persistence);
    const { a, b, c } = setupStack(orchestrator);

    orchestrator.cancelWorkflow(c.wfId);
    orchestrator.cancelWorkflow(b.wfId);
    const bAfterOwnCancel = workflowTaskStatuses(orchestrator, b.wfId);
    expect(Object.values(bAfterOwnCancel)).not.toContain('pending');

    orchestrator.cancelWorkflow(a.wfId);

    expect(workflowTaskStatuses(orchestrator, b.wfId)).toEqual(bAfterOwnCancel);
    expect(persistence.loadWorkflow(b.wfId)!.baseBranch).toBe('plan/slice-1');
    expect(persistence.loadWorkflow(c.wfId)!.baseBranch).toBe('plan/slice-2');
    expect(orchestrator.getExecutableReadyTasks().map((t) => t.id)).toEqual([]);
  });
});
