import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from '@invoker/data-store';
import { InMemoryBus } from '@invoker/test-kit';
import { Orchestrator, type PlanDefinition } from '@invoker/workflow-core';
import { loadDefaultExecutionAgent } from '../config.js';
import { applyConfiguredPlanDefaults } from '../plan-parser.js';

const PLAN: PlanDefinition = {
  name: 'merge-node-default-agent',
  baseBranch: 'master',
  featureBranch: 'feature/merge-node-default-agent',
  tasks: [
    { id: 'implement', description: 'Implement', prompt: 'Do the thing' },
    { id: 'verify', description: 'Verify', command: 'echo verify', dependencies: ['implement'] },
  ],
};

const COMMAND_ONLY_PLAN: PlanDefinition = {
  name: 'merge-node-default-agent-commands',
  baseBranch: 'master',
  featureBranch: 'feature/merge-node-default-agent-commands',
  tasks: [{ id: 'verify', description: 'Verify', command: 'echo verify' }],
};

describe('submitted merge node execution agent', () => {
  let configDir: string;
  let adapter: SQLiteAdapter | undefined;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'invoker-merge-node-agent-'));
    process.env.INVOKER_REPO_CONFIG_PATH = join(configDir, 'config.json');
  });

  afterEach(() => {
    adapter?.close();
    adapter = undefined;
    delete process.env.INVOKER_REPO_CONFIG_PATH;
    rmSync(configDir, { recursive: true, force: true });
  });

  function writeConfig(value: Record<string, unknown>): void {
    writeFileSync(process.env.INVOKER_REPO_CONFIG_PATH!, JSON.stringify(value));
  }

  async function submitAndReadMergeAgent(plan: PlanDefinition): Promise<string | null | undefined> {
    adapter = await SQLiteAdapter.create(':memory:');
    const orchestrator = new Orchestrator({
      persistence: adapter as never,
      messageBus: new InMemoryBus(),
      maxConcurrency: 1,
      defaultExecutionAgentProvider: loadDefaultExecutionAgent,
    });
    orchestrator.loadPlan(applyConfiguredPlanDefaults(plan));
    const mergeNode = orchestrator.getAllTasks().find((task) => task.config.isMergeNode);
    expect(mergeNode).toBeDefined();
    expect(mergeNode?.config.executionAgent).toBe(adapter.getExecutionAgent(mergeNode!.id));
    return adapter.getExecutionAgent(mergeNode!.id);
  }

  it('persists the configured default agent on the merge node', async () => {
    writeConfig({ defaultExecutionAgent: 'claude' });

    expect(await submitAndReadMergeAgent(PLAN)).toBe('claude');
  });

  it('persists the configured default agent on a merge node whose tasks declare none', async () => {
    writeConfig({ defaultExecutionAgent: 'claude' });

    expect(await submitAndReadMergeAgent(COMMAND_ONLY_PLAN)).toBe('claude');
  });

  it('falls back to the built-in default agent when config sets nothing', async () => {
    writeConfig({});

    expect(await submitAndReadMergeAgent(COMMAND_ONLY_PLAN)).toBe('codex');
  });
});
