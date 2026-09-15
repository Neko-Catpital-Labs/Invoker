import { describe, it, expect } from 'vitest';
import { Orchestrator, type OrchestratorConfig } from '../orchestrator.js';
import type { PlanDefinition } from '../plan-parser.js';
import { InMemoryPersistence, InMemoryBus } from './helpers/cross-workflow-cascade-helpers.js';

function makeOrchestrator(overrides: Partial<OrchestratorConfig> = {}): Orchestrator {
  return new Orchestrator({
    persistence: new InMemoryPersistence(),
    messageBus: new InMemoryBus(),
    maxConcurrency: 2,
    ...overrides,
  });
}

function commandPlan(name: string): PlanDefinition {
  return {
    name,
    baseBranch: 'master',
    featureBranch: `feature/${name}`,
    tasks: [
      { id: 'build', description: 'Build', command: 'echo build' },
      { id: 'verify', description: 'Verify', command: 'echo verify', dependencies: ['build'] },
    ],
  };
}

function mergeNodeOf(orchestrator: Orchestrator, workflowId: string) {
  return orchestrator
    .getAllTasks()
    .find((task) => task.config.isMergeNode && task.config.workflowId === workflowId);
}

function submit(orchestrator: Orchestrator, plan: PlanDefinition): string {
  orchestrator.loadPlan(plan);
  const workflowId = orchestrator.getAllTasks().find((task) => task.config.isMergeNode)?.config.workflowId;
  if (!workflowId) throw new Error('merge node not created');
  return workflowId;
}

describe('merge node execution agent', () => {
  it('carries the configured default agent on a submitted plan', () => {
    const orchestrator = makeOrchestrator({ defaultExecutionAgentProvider: () => 'claude' });

    const workflowId = submit(orchestrator, commandPlan('configured-default'));

    expect(mergeNodeOf(orchestrator, workflowId)?.config.executionAgent).toBe('claude');
  });

  it('leaves the agent unset when config names no default, so the built-in fallback applies', () => {
    const withoutProvider = makeOrchestrator();
    const blankProvider = makeOrchestrator({ defaultExecutionAgentProvider: () => '   ' });
    const emptyProvider = makeOrchestrator({ defaultExecutionAgentProvider: () => undefined });

    for (const orchestrator of [withoutProvider, blankProvider, emptyProvider]) {
      const workflowId = submit(orchestrator, commandPlan('no-default'));
      const mergeNode = mergeNodeOf(orchestrator, workflowId);
      expect(mergeNode?.config.executionAgent).toBeUndefined();
      expect(mergeNode?.config).not.toHaveProperty('executionAgent');
    }
  });

  it('prefers an agent the plan tasks declare over the configured default', () => {
    const orchestrator = makeOrchestrator({ defaultExecutionAgentProvider: () => 'claude' });
    const plan = commandPlan('declared-agent');
    plan.tasks[0] = { ...plan.tasks[0], command: undefined, prompt: 'Build it', executionAgent: 'omp' };

    const workflowId = submit(orchestrator, plan);

    expect(mergeNodeOf(orchestrator, workflowId)?.config.executionAgent).toBe('omp');
  });

  it('carries the configured default on a forked workflow merge node', () => {
    let configured: string | undefined;
    const orchestrator = makeOrchestrator({ defaultExecutionAgentProvider: () => configured });
    const sourceWorkflowId = submit(orchestrator, commandPlan('fork-default'));
    expect(mergeNodeOf(orchestrator, sourceWorkflowId)?.config.executionAgent).toBeUndefined();

    configured = 'claude';
    const { forkedWorkflowId } = orchestrator.forkWorkflow(sourceWorkflowId, { autoStart: false });

    expect(mergeNodeOf(orchestrator, forkedWorkflowId)?.config.executionAgent).toBe('claude');
  });

  it('keeps the source merge node agent on a forked workflow', () => {
    const orchestrator = makeOrchestrator({ defaultExecutionAgentProvider: () => 'claude' });
    const sourceWorkflowId = submit(orchestrator, commandPlan('fork-source-agent'));
    orchestrator.editTaskAgent(mergeNodeOf(orchestrator, sourceWorkflowId)!.id, 'omp');

    const { forkedWorkflowId } = orchestrator.forkWorkflow(sourceWorkflowId, { autoStart: false });

    expect(mergeNodeOf(orchestrator, forkedWorkflowId)?.config.executionAgent).toBe('omp');
  });

  it('leaves a forked merge node unset when neither source nor config names an agent', () => {
    const orchestrator = makeOrchestrator();
    const sourceWorkflowId = submit(orchestrator, commandPlan('fork-no-default'));

    const { forkedWorkflowId } = orchestrator.forkWorkflow(sourceWorkflowId, { autoStart: false });

    expect(mergeNodeOf(orchestrator, forkedWorkflowId)?.config.executionAgent).toBeUndefined();
  });
});
