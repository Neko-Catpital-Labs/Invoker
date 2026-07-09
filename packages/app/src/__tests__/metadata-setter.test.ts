import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseMetadataValue,
  setTaskMetadata,
  setWorkflowMetadata,
} from '../metadata-setter.js';

function makeDeps() {
  const task = {
    id: 'task-1',
    description: 'Task one',
    dependencies: [],
    config: { workflowId: 'wf-1' },
    execution: {},
  };
  return {
    commandService: {
      runSerializedForWorkflow: vi.fn(async (_workflowId: string, fn: () => unknown) => {
        await fn();
        return { ok: true, data: undefined };
      }),
    },
    orchestrator: {
      syncFromDb: vi.fn(),
    },
    persistence: {
      loadWorkflow: vi.fn(() => ({ id: 'wf-1', name: 'Workflow one' })),
      listWorkflows: vi.fn(() => [{ id: 'wf-1', name: 'Workflow one' }]),
      loadTask: vi.fn((id: string) => (id === 'task-1' ? task : undefined)),
      loadTasks: vi.fn(() => [task]),
      updateWorkflow: vi.fn(),
      updateTask: vi.fn(),
      logEvent: vi.fn(),
    },
  } as any;
}

describe('metadata-setter', () => {
  const originalRawFlag = process.env.INVOKER_ALLOW_RAW_METADATA_SET;

  beforeEach(() => {
    delete process.env.INVOKER_ALLOW_RAW_METADATA_SET;
  });

  afterEach(() => {
    if (originalRawFlag === undefined) delete process.env.INVOKER_ALLOW_RAW_METADATA_SET;
    else process.env.INVOKER_ALLOW_RAW_METADATA_SET = originalRawFlag;
  });

  it('parses JSON values and falls back to strings', () => {
    expect(parseMetadataValue('null')).toBeNull();
    expect(parseMetadataValue('["a","b"]')).toEqual(['a', 'b']);
    expect(parseMetadataValue('git@github.com:Neko-Catpital-Labs/Invoker.git')).toBe('git@github.com:Neko-Catpital-Labs/Invoker.git');
  });

  it('sets allowed workflow metadata through serialized workflow mutation', async () => {
    const deps = makeDeps();
    await setWorkflowMetadata(deps, 'wf-1', 'repoUrl', 'git@github.com:Neko-Catpital-Labs/Invoker.git');

    expect(deps.commandService.runSerializedForWorkflow).toHaveBeenCalledWith('wf-1', expect.any(Function));
    expect(deps.persistence.updateWorkflow).toHaveBeenCalledWith('wf-1', {
      repoUrl: 'git@github.com:Neko-Catpital-Labs/Invoker.git',
    });
    expect(deps.persistence.logEvent).toHaveBeenCalledWith('task-1', 'workflow.metadata.updated', expect.objectContaining({
      workflowId: 'wf-1',
      fieldPath: 'repoUrl',
    }));
    expect(deps.orchestrator.syncFromDb).toHaveBeenCalledWith('wf-1');
  });

  it('sets allowed task config metadata through serialized workflow mutation', async () => {
    const deps = makeDeps();
    await setTaskMetadata(deps, 'task-1', 'config.poolId', 'some-pool');

    expect(deps.commandService.runSerializedForWorkflow).toHaveBeenCalledWith('wf-1', expect.any(Function));
    expect(deps.persistence.updateTask).toHaveBeenCalledWith('task-1', {
      config: { poolId: 'some-pool' },
    });
    expect(deps.persistence.logEvent).toHaveBeenCalledWith('task-1', 'task.metadata.updated', expect.objectContaining({
      taskId: 'task-1',
      fieldPath: 'config.poolId',
    }));
  });

  it('rejects forbidden task runtime and structural fields in normal mode', async () => {
    const deps = makeDeps();
    await expect(setTaskMetadata(deps, 'task-1', 'execution.error', 'boom')).rejects.toThrow(/not allowed/);
    await expect(setTaskMetadata(deps, 'task-1', 'status', 'failed')).rejects.toThrow(/not allowed/);
    await expect(setTaskMetadata(deps, 'task-1', 'config.workflowId', 'wf-2')).rejects.toThrow(/not allowed/);
    expect(deps.persistence.updateTask).not.toHaveBeenCalled();
  });

  it('rejects invalid enum and type values', async () => {
    const deps = makeDeps();
    await expect(setWorkflowMetadata(deps, 'wf-1', 'mergeMode', 'sometimes')).rejects.toThrow(/manual, automatic, external_review/);
    await expect(setTaskMetadata(deps, 'task-1', 'dependencies', 'task-a')).rejects.toThrow(/array of strings/);
    await expect(setTaskMetadata(deps, 'task-1', 'config.requiresManualApproval', 'true')).rejects.toThrow(/boolean/);
  });

  it('gates raw repair mode behind INVOKER_ALLOW_RAW_METADATA_SET', async () => {
    const deps = makeDeps();
    await expect(setTaskMetadata(deps, 'task-1', 'raw.execution.error', 'boom')).rejects.toThrow(/Raw metadata updates are disabled/);

    process.env.INVOKER_ALLOW_RAW_METADATA_SET = '1';
    await setTaskMetadata(deps, 'task-1', 'raw.execution.error', 'boom');

    expect(deps.persistence.updateTask).toHaveBeenCalledWith('task-1', {
      execution: { error: 'boom' },
    });
  });
});
