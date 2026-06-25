import type { CommandService, TaskStateChanges } from '@invoker/workflow-core';
import { normalizeRunnerKind } from '@invoker/workflow-core';
import type { SQLiteAdapter, Workflow } from '@invoker/data-store';
import type { Orchestrator } from '@invoker/workflow-core';

export type MetadataScope = 'task' | 'workflow';

export interface MetadataSetResult {
  scope: MetadataScope;
  id: string;
  fieldPath: string;
  value: unknown;
  raw: boolean;
}

export interface MetadataSetDeps {
  commandService: CommandService;
  orchestrator: Pick<Orchestrator, 'syncFromDb'>;
  persistence: Pick<
    SQLiteAdapter,
    'loadWorkflow' | 'loadTask' | 'loadTasks' | 'listWorkflows' | 'updateWorkflow' | 'updateTask' | 'logEvent'
  >;
}

const WORKFLOW_FIELDS = new Set([
  'name',
  'description',
  'visualProof',
  'planFile',
  'repoUrl',
  'intermediateRepoUrl',
  'branch',
  'onFinish',
  'baseBranch',
  'featureBranch',
  'mergeMode',
  'reviewProvider',
  'externalDependencies',
  'externalDependencyChanges',
]);

const TASK_FIELDS = new Set(['description', 'dependencies']);

const TASK_CONFIG_FIELDS = new Set([
  'command',
  'prompt',
  'experimentPrompt',
  'parentTask',
  'featureBranch',
  'runnerKind',
  'poolId',
  'poolMemberId',
  'dockerImage',
  'executionAgent',
  'executionModel',
  'pivot',
  'experimentVariants',
  'isReconciliation',
  'requiresManualApproval',
  'summary',
  'problem',
  'approach',
  'testPlan',
  'reproCommand',
  'fixPrompt',
  'fixContext',
]);

const WORKFLOW_STRING_FIELDS = new Set([
  'description',
  'planFile',
  'repoUrl',
  'intermediateRepoUrl',
  'branch',
  'baseBranch',
  'featureBranch',
  'reviewProvider',
]);

const TASK_CONFIG_STRING_FIELDS = new Set([
  'command',
  'prompt',
  'experimentPrompt',
  'parentTask',
  'featureBranch',
  'poolId',
  'poolMemberId',
  'dockerImage',
  'executionAgent',
  'executionModel',
  'summary',
  'problem',
  'approach',
  'testPlan',
  'reproCommand',
  'fixPrompt',
  'fixContext',
]);

export function parseMetadataValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function assertRawAllowed(raw: boolean): void {
  if (raw && process.env.INVOKER_ALLOW_RAW_METADATA_SET !== '1') {
    throw new Error('Raw metadata updates are disabled. Set INVOKER_ALLOW_RAW_METADATA_SET=1 to enable repair mode.');
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullableString(fieldPath: string, value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`Field "${fieldPath}" must be a string or null.`);
  return value;
}

function requiredString(fieldPath: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Field "${fieldPath}" must be a non-empty string.`);
  }
  return value;
}

function booleanValue(fieldPath: string, value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error(`Field "${fieldPath}" must be a boolean.`);
  return value;
}

function stringArray(fieldPath: string, value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`Field "${fieldPath}" must be an array of strings.`);
  }
  return value;
}

function enumValue<T extends string>(fieldPath: string, value: unknown, allowed: readonly T[]): T | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`Field "${fieldPath}" must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

function validateWorkflowValue(fieldPath: string, value: unknown, raw: boolean): Partial<Workflow> {
  const path = raw && fieldPath.startsWith('raw.') ? fieldPath.slice(4) : fieldPath;
  if (!raw && !WORKFLOW_FIELDS.has(path)) {
    throw new Error(`Field "${fieldPath}" is not allowed for workflow metadata updates.`);
  }
  if (path.includes('.')) {
    throw new Error(`Nested workflow field "${fieldPath}" is not supported.`);
  }

  if (path === 'name') return { name: requiredString(path, value) };
  if (path === 'visualProof') return { visualProof: booleanValue(path, value) };
  if (path === 'onFinish') {
    return { onFinish: enumValue<'none' | 'merge' | 'pull_request'>(path, value, ['none', 'merge', 'pull_request']) ?? undefined };
  }
  if (path === 'mergeMode') {
    return { mergeMode: enumValue<'manual' | 'automatic' | 'external_review'>(path, value, ['manual', 'automatic', 'external_review']) ?? undefined };
  }
  if (path === 'externalDependencies' || path === 'externalDependencyChanges') {
    if (value !== null && !Array.isArray(value)) throw new Error(`Field "${fieldPath}" must be an array or null.`);
    return { [path]: value ?? undefined } as Partial<Workflow>;
  }
  if (WORKFLOW_STRING_FIELDS.has(path)) {
    return { [path]: nullableString(path, value) ?? undefined } as Partial<Workflow>;
  }

  if (raw && (path === 'generation')) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new Error(`Field "${fieldPath}" must be a non-negative integer.`);
    }
    return { generation: value };
  }
  throw new Error(`Field "${fieldPath}" is not persisted as workflow metadata.`);
}

function validateTaskValue(fieldPath: string, value: unknown, raw: boolean): TaskStateChanges {
  const path = raw && fieldPath.startsWith('raw.') ? fieldPath.slice(4) : fieldPath;
  const parts = path.split('.');
  if (!raw) {
    const allowed = parts.length === 1
      ? TASK_FIELDS.has(path)
      : parts.length === 2 && parts[0] === 'config' && TASK_CONFIG_FIELDS.has(parts[1]);
    if (!allowed) throw new Error(`Field "${fieldPath}" is not allowed for task metadata updates.`);
  }

  if (path === 'description') return { description: requiredString(path, value) } as TaskStateChanges;
  if (path === 'dependencies') return { dependencies: stringArray(path, value) };
  if (parts[0] !== 'config' || parts.length !== 2) {
    if (raw && path === 'status') return { status: requiredString(path, value) as TaskStateChanges['status'] };
    if (raw && parts[0] === 'execution' && parts.length === 2) return { execution: { [parts[1]]: value } as TaskStateChanges['execution'] };
    throw new Error(`Field "${fieldPath}" is not persisted as task metadata/config.`);
  }

  const key = parts[1];
  if (key === 'runnerKind') {
    const runnerKind = value === null ? undefined : normalizeRunnerKind(requiredString(path, value));
    return { config: { runnerKind } as TaskStateChanges['config'] };
  }
  if (key === 'pivot' || key === 'isReconciliation' || key === 'requiresManualApproval') {
    return { config: { [key]: booleanValue(path, value) } as TaskStateChanges['config'] };
  }
  if (key === 'experimentVariants') {
    if (value !== null && !Array.isArray(value)) throw new Error(`Field "${fieldPath}" must be an array or null.`);
    return { config: { [key]: value ?? undefined } as TaskStateChanges['config'] };
  }
  if (TASK_CONFIG_STRING_FIELDS.has(key)) {
    return { config: { [key]: nullableString(path, value) ?? undefined } as TaskStateChanges['config'] };
  }
  if (raw) return { config: { [key]: value } as TaskStateChanges['config'] };
  throw new Error(`Field "${fieldPath}" is not allowed for task metadata updates.`);
}

function taskWorkflowId(deps: MetadataSetDeps, taskId: string): { workflowId: string; resolvedTaskId: string } {
  const direct = deps.persistence.loadTask(taskId);
  if (direct?.config.workflowId) return { workflowId: direct.config.workflowId, resolvedTaskId: direct.id };
  for (const workflow of deps.persistence.listWorkflows()) {
    const task = deps.persistence.loadTasks(workflow.id).find((candidate) => candidate.id === taskId || candidate.id.endsWith(`/${taskId}`));
    if (task) return { workflowId: workflow.id, resolvedTaskId: task.id };
  }
  throw new Error(`Task "${taskId}" not found.`);
}

export async function setWorkflowMetadata(
  deps: MetadataSetDeps,
  workflowId: string,
  fieldPath: string,
  value: unknown,
  options: { raw?: boolean } = {},
): Promise<MetadataSetResult> {
  const raw = options.raw === true || fieldPath.startsWith('raw.');
  assertRawAllowed(raw);
  if (!workflowId || !fieldPath) throw new Error('Missing workflow metadata setter arguments.');
  const patch = validateWorkflowValue(fieldPath, value, raw);
  const result = await deps.commandService.runSerializedForWorkflow(workflowId, async () => {
    if (!deps.persistence.loadWorkflow(workflowId)) throw new Error(`Workflow "${workflowId}" not found.`);
    deps.persistence.updateWorkflow(workflowId, patch);
    const auditTask = deps.persistence.loadTasks(workflowId)[0];
    if (auditTask) {
      deps.persistence.logEvent(auditTask.id, 'workflow.metadata.updated', {
        workflowId,
        fieldPath,
        value,
        raw,
      });
    }
    deps.orchestrator.syncFromDb(workflowId);
  });
  if (!result.ok) throw new Error(result.error.message);
  return { scope: 'workflow', id: workflowId, fieldPath, value, raw };
}

export async function setTaskMetadata(
  deps: MetadataSetDeps,
  taskId: string,
  fieldPath: string,
  value: unknown,
  options: { raw?: boolean } = {},
): Promise<MetadataSetResult> {
  const raw = options.raw === true || fieldPath.startsWith('raw.');
  assertRawAllowed(raw);
  if (!taskId || !fieldPath) throw new Error('Missing task metadata setter arguments.');
  const changes = validateTaskValue(fieldPath, value, raw);
  const resolved = taskWorkflowId(deps, taskId);
  const result = await deps.commandService.runSerializedForWorkflow(resolved.workflowId, async () => {
    deps.persistence.updateTask(resolved.resolvedTaskId, changes);
    deps.persistence.logEvent(resolved.resolvedTaskId, 'task.metadata.updated', {
      taskId: resolved.resolvedTaskId,
      fieldPath,
      value,
      raw,
    });
    deps.orchestrator.syncFromDb(resolved.workflowId);
  });
  if (!result.ok) throw new Error(result.error.message);
  return { scope: 'task', id: resolved.resolvedTaskId, fieldPath, value, raw };
}

export function parseMetadataPatchBody(body: string): { fieldPath: string; value: unknown; raw: boolean } {
  const parsed = body ? JSON.parse(body) : {};
  if (!isObjectRecord(parsed)) throw new Error('Metadata patch body must be a JSON object.');
  const fieldPath = parsed.fieldPath ?? parsed.path ?? parsed.field;
  if (typeof fieldPath !== 'string' || fieldPath.length === 0) {
    throw new Error('Missing "fieldPath" in request body.');
  }
  if (!('value' in parsed)) throw new Error('Missing "value" in request body.');
  return { fieldPath, value: parsed.value, raw: parsed.raw === true };
}
