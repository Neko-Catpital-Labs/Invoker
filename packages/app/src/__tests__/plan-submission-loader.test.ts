import { afterEach, describe, expect, it } from 'vitest';

import type { Logger } from '@invoker/contracts';
import { SQLiteAdapter } from '@invoker/data-store';
import { InMemoryBus } from '@invoker/test-kit';
import { Orchestrator, type PlanDefinition } from '@invoker/workflow-core';

import { loadPlanSubmissionDefinitions } from '../plan-submission-loader.js';

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
};

const adapters: SQLiteAdapter[] = [];

function definition(name: string, featureBranch: string, taskId: string): PlanDefinition {
  return {
    name,
    repoUrl: 'git@github.com:test/repo.git',
    baseBranch: 'main',
    featureBranch,
    onFinish: 'none',
    mergeMode: 'manual',
    tasks: [
      {
        id: taskId,
        description: `Run ${taskId}`,
        command: 'true',
      },
    ],
  };
}

afterEach(() => {
  while (adapters.length > 0) {
    adapters.pop()?.close();
  }
});

describe('loadPlanSubmissionDefinitions', () => {
  it('loads stacked definitions and links downstream workflows to the upstream merge gate', async () => {
    const persistence = await SQLiteAdapter.create(':memory:');
    adapters.push(persistence);
    const orchestrator = new Orchestrator({
      persistence: persistence as never,
      messageBus: new InMemoryBus(),
    });

    const loaded = loadPlanSubmissionDefinitions([
      definition('Upstream repair', 'stack/5800', 'repair-anchor'),
      definition('Downstream repair', 'stack/5801', 'repair-anchor'),
    ], {
      orchestrator,
      persistence,
      logger,
      allowGraphMutation: false,
    });

    expect(loaded.workflowIds).toHaveLength(2);
    expect(loaded.primaryWorkflowId).toBe(loaded.workflowIds[1]);

    const upstreamWorkflow = persistence.loadWorkflow(loaded.workflowIds[0]!);
    const downstreamWorkflow = persistence.loadWorkflow(loaded.workflowIds[1]!);
    expect(upstreamWorkflow?.featureBranch).toBe('stack/5800');
    expect(downstreamWorkflow?.baseBranch).toBe('stack/5800');
    expect(downstreamWorkflow?.externalDependencies).toEqual([
      {
        workflowId: loaded.workflowIds[0],
        taskId: '__merge__',
        requiredStatus: 'completed',
        gatePolicy: 'review_ready',
      },
    ]);
  });
});
