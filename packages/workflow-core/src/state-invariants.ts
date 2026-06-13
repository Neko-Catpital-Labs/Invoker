import type { ExternalDependency, ExternalDependencyChange, TaskState } from '@invoker/workflow-graph';

export interface WorkflowInvariantLike {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly generation?: unknown;
  readonly externalDependencies?: unknown;
  readonly externalDependencyChanges?: unknown;
}

export interface WorkflowPatchLike {
  readonly externalDependencyChanges?: unknown;
}

const VALID_GATE_POLICIES: Record<string, true> = {
  completed: true,
  review_ready: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function describeWorkflow(workflow: WorkflowInvariantLike): string {
  return nonEmptyString(workflow.id) ? `workflow ${workflow.id}` : 'workflow';
}

function dependencyKey(dep: ExternalDependency): string {
  return `${dep.workflowId}\u0000${dep.taskId ?? ''}`;
}

function assertDependencyConsistent(dep: unknown, path: string): asserts dep is ExternalDependency {
  if (!isRecord(dep)) {
    throw new Error(`${path} must be an object`);
  }
  if (!nonEmptyString(dep.workflowId)) {
    throw new Error(`${path}.workflowId must be a non-empty string`);
  }
  if (hasOwn(dep, 'taskId') && dep.taskId !== undefined && !nonEmptyString(dep.taskId)) {
    throw new Error(`${path}.taskId must be a non-empty string when present`);
  }
  if (dep.requiredStatus !== 'completed') {
    throw new Error(`${path}.requiredStatus must be completed`);
  }
  if (hasOwn(dep, 'gatePolicy') && dep.gatePolicy !== undefined && VALID_GATE_POLICIES[String(dep.gatePolicy)] !== true) {
    throw new Error(`${path}.gatePolicy must be completed or review_ready`);
  }
}

function assertDependencyChangeConsistent(change: unknown, path: string): asserts change is ExternalDependencyChange {
  if (!isRecord(change)) {
    throw new Error(`${path} must be an object`);
  }
  const hasBefore = hasOwn(change, 'before') && change.before !== undefined;
  const hasAfter = hasOwn(change, 'after') && change.after !== undefined;
  if (!hasBefore && !hasAfter) {
    throw new Error(`${path} must include before or after`);
  }
  if (hasBefore) {
    assertDependencyConsistent(change.before, `${path}.before`);
  }
  if (hasAfter) {
    assertDependencyConsistent(change.after, `${path}.after`);
  }
  if (!nonEmptyString(change.changedAt) || Number.isNaN(Date.parse(change.changedAt))) {
    throw new Error(`${path}.changedAt must be a valid date string`);
  }
}

function readDependencies(workflow: WorkflowInvariantLike): readonly ExternalDependency[] {
  const deps = workflow.externalDependencies;
  if (deps === undefined) return [];
  if (!Array.isArray(deps)) {
    throw new Error(`${describeWorkflow(workflow)} externalDependencies must be an array when present`);
  }
  if (deps.length === 0) {
    throw new Error(`${describeWorkflow(workflow)} externalDependencies must be non-empty when present`);
  }
  deps.forEach((dep, index) => assertDependencyConsistent(dep, `${describeWorkflow(workflow)} externalDependencies[${index}]`));
  return deps;
}

function readDependencyChanges(owner: WorkflowInvariantLike | WorkflowPatchLike, ownerLabel: string): readonly ExternalDependencyChange[] {
  const changes = owner.externalDependencyChanges;
  if (changes === undefined) return [];
  if (!Array.isArray(changes)) {
    throw new Error(`${ownerLabel} externalDependencyChanges must be an array when present`);
  }
  changes.forEach((change, index) => assertDependencyChangeConsistent(change, `${ownerLabel} externalDependencyChanges[${index}]`));
  return changes;
}

export function assertWorkflowConsistent(workflow: WorkflowInvariantLike): void {
  if (!nonEmptyString(workflow.id)) {
    throw new Error('workflow.id must be a non-empty string');
  }
  if (!nonEmptyString(workflow.name)) {
    throw new Error(`workflow ${String(workflow.id)} name must be a non-empty string`);
  }
  const generation = workflow.generation;
  if (generation !== undefined && (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 0)) {
    throw new Error(`workflow ${workflow.id} generation must be an integer >= 0 when present`);
  }
  readDependencies(workflow);
  readDependencyChanges(workflow, describeWorkflow(workflow));
}

export function assertWorkflowPatchConsistent(
  before: WorkflowInvariantLike,
  after: WorkflowInvariantLike,
  patch?: WorkflowPatchLike,
): void {
  assertWorkflowConsistent(before);
  assertWorkflowConsistent(after);

  const beforeDeps = readDependencies(before);
  if (beforeDeps.length === 0) return;

  const afterDepsByKey = new Set(readDependencies(after).map(dependencyKey));
  const removedDeps = beforeDeps.filter((dep) => !afterDepsByKey.has(dependencyKey(dep)));
  if (removedDeps.length === 0) return;

  if (!patch || !hasOwn(patch, 'externalDependencyChanges')) {
    throw new Error(`workflow ${before.id} removed externalDependencies without externalDependencyChanges`);
  }

  const removals = readDependencyChanges(patch, `workflow ${before.id} patch`)
    .filter((change) => change.before !== undefined && change.after === undefined)
    .map((change) => dependencyKey(change.before!));
  const removalKeys = new Set(removals);
  const missing = removedDeps.filter((dep) => !removalKeys.has(dependencyKey(dep)));
  if (missing.length > 0) {
    throw new Error(`workflow ${before.id} removed externalDependencies without removal history for ${missing.map(dependencyKey).join(', ')}`);
  }
}

export function assertTaskConsistent(task: TaskState): void {
  if (!nonEmptyString(task.id)) {
    throw new Error('task.id must be a non-empty string');
  }
}
