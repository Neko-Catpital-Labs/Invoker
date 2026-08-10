import { parse as parseYaml } from 'yaml';
import type { PlanDefinition } from './orchestrator.js';
import { normalizeWorkflowBaseBranch } from './repo-default-branch.js';

export class PlanParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanParseError';
  }
}

export interface RawExperimentVariant {
  id?: string;
  description?: string;
  prompt?: string;
  command?: string;
}

export interface RawPlanTask {
  id?: string;
  description?: string;
  command?: string;
  prompt?: string;
  dependencies?: string[];
  externalDependencies?: Array<{
    workflowId?: string;
    taskId?: string;
    requiredStatus?: string;
    gatePolicy?: string;
  }>;
  pivot?: boolean;
  experimentVariants?: RawExperimentVariant[];
  requiresManualApproval?: boolean;
  featureBranch?: string;
  dockerImage?: string;
  poolId?: string;
  executionAgent?: string;
  executionModel?: string;
}

export interface RawPlan {
  name?: string;
  description?: string;
  visualProof?: boolean;
  onFinish?: string;
  baseBranch?: string;
  featureBranch?: string;
  mergeMode?: string;
  reviewProvider?: string;
  repoUrl?: string;
  scratch?: boolean;
  intermediateRepoUrl?: string;
  externalDependencies?: Array<{
    workflowId?: string;
    taskId?: string;
    requiredStatus?: string;
    gatePolicy?: string;
  }>;
  tasks?: RawPlanTask[];
}


function resolveDefaultBaseBranch(plan: PlanDefinition): string {
  return normalizeWorkflowBaseBranch(plan.baseBranch);
}

export function applyPlanDefinitionDefaults(plan: PlanDefinition): PlanDefinition {
  const slug = plan.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const featureBranch = typeof plan.featureBranch === 'string' && plan.featureBranch.trim() !== ''
    ? plan.featureBranch.trim()
    : `plan/${slug}`;

  return {
    ...plan,
    onFinish: plan.onFinish ?? 'pull_request',
    baseBranch: resolveDefaultBaseBranch(plan),
    featureBranch,
  };
}

type ParsedExternalDependency = {
  workflowId: string;
  taskId: string;
  requiredStatus: 'completed';
  gatePolicy: 'completed' | 'review_ready';
};

function parseExternalDependencies(
  ownerLabel: string,
  deps?: Array<{ workflowId?: string; taskId?: string; requiredStatus?: string; gatePolicy?: string }>,
): ParsedExternalDependency[] | undefined {
  if (!deps) return undefined;
  return deps.map((dep, depIndex) => {
    if (!dep.workflowId || typeof dep.workflowId !== 'string') {
      throw new PlanParseError(`${ownerLabel} externalDependencies[${depIndex}] must have a string "workflowId"`);
    }
    if (dep.taskId !== undefined && typeof dep.taskId !== 'string') {
      throw new PlanParseError(`${ownerLabel} externalDependencies[${depIndex}] "taskId" must be a string when provided`);
    }
    if (dep.requiredStatus !== undefined && dep.requiredStatus !== 'completed') {
      throw new PlanParseError(`${ownerLabel} externalDependencies[${depIndex}] "requiredStatus" must be "completed"`);
    }
    if (dep.gatePolicy !== undefined && dep.gatePolicy !== 'completed' && dep.gatePolicy !== 'review_ready') {
      if (dep.gatePolicy === 'approved') {
        throw new PlanParseError("gatePolicy value 'approved' is no longer supported. Use 'completed' instead.");
      }
      throw new PlanParseError(`${ownerLabel} externalDependencies[${depIndex}] "gatePolicy" must be "completed" or "review_ready"`);
    }
    const taskId = dep.taskId?.trim() || '__merge__';
    return {
      workflowId: dep.workflowId,
      taskId,
      requiredStatus: 'completed',
      gatePolicy: (dep.gatePolicy ?? (taskId === '__merge__' ? 'completed' : 'review_ready')) as 'completed' | 'review_ready',
    };
  });
}

function mergeExternalDependencies(
  inheritedDeps: ParsedExternalDependency[] | undefined,
  taskDeps: ParsedExternalDependency[] | undefined,
): ParsedExternalDependency[] | undefined {
  if (!inheritedDeps && !taskDeps) return undefined;
  const merged = new Map<string, ParsedExternalDependency>();
  for (const dep of inheritedDeps ?? []) merged.set(`${dep.workflowId}::${dep.taskId}`, dep);
  for (const dep of taskDeps ?? []) merged.set(`${dep.workflowId}::${dep.taskId}`, dep);
  const values = [...merged.values()];
  return values.length > 0 ? values : undefined;
}

const legacyTaskRoutingKeys = [
  ['executor', 'Type'].join(''),
  ['remote', 'Target', 'Id'].join(''),
  'runnerKind',
  'poolMemberId',
] as const;

function assertNoLegacyRoutingKeys(ownerLabel: string, value: object): void {
  for (const key of legacyTaskRoutingKeys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      throw new PlanParseError(
        `${ownerLabel} uses unsupported routing field "${key}". Use "poolId" for pools and "dockerImage" for Docker.`,
      );
    }
  }
}

export function parsePlan(yamlContent: string): PlanDefinition {
  let raw: RawPlan;
  try {
    raw = parseYaml(yamlContent) as RawPlan;
  } catch (err) {
    throw new PlanParseError(`Invalid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!raw || typeof raw !== 'object') throw new PlanParseError('Plan must be a YAML object');
  if (!raw.name || typeof raw.name !== 'string') throw new PlanParseError('Plan must have a "name" field');
  if (!raw.tasks || !Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    throw new PlanParseError('Plan must have a non-empty "tasks" array');
  }

  const hasOwn = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);
  if (hasOwn(raw as object, 'autoFix')) {
    throw new PlanParseError('Plan-level "autoFix" is no longer supported. Configure "~/.invoker/config.json" with "autoFixRetries" instead.');
  }
  if (hasOwn(raw as object, 'autoFixRetries')) {
    throw new PlanParseError('Plan-level "autoFixRetries" is no longer supported. Configure "~/.invoker/config.json" with "autoFixRetries" instead.');
  }
  assertNoLegacyRoutingKeys('Plan', raw as object);

  if (raw.scratch !== undefined && typeof raw.scratch !== 'boolean') {
    throw new PlanParseError('Plan "scratch" must be a boolean when provided.');
  }
  const scratch = raw.scratch === true;

  const validOnFinishValues = ['none', 'merge', 'pull_request'] as const;
  if (raw.onFinish !== undefined && !validOnFinishValues.includes(raw.onFinish as any)) {
    throw new PlanParseError(`"onFinish" must be one of: ${validOnFinishValues.join(', ')}. Got: "${raw.onFinish}"`);
  }
  if (scratch && raw.onFinish !== undefined && raw.onFinish !== 'none') {
    throw new PlanParseError('Plan with "scratch: true" must use onFinish: "none" (or omit it) — there is no branch/PR to finish.');
  }
  const onFinish = (raw.onFinish as (typeof validOnFinishValues)[number]) ?? (scratch ? 'none' : 'pull_request');

  const validMergeModes = ['manual', 'automatic', 'external_review', 'no_op'] as const;
  if (raw.mergeMode !== undefined && !validMergeModes.includes(raw.mergeMode as any)) {
    throw new PlanParseError(`"mergeMode" must be one of: ${validMergeModes.join(', ')}. Got: "${raw.mergeMode}"`);
  }
  if (scratch && raw.mergeMode !== undefined && raw.mergeMode !== 'no_op') {
    throw new PlanParseError('Plan with "scratch: true" must use mergeMode: "no_op" (or omit it) — there is no repo/branch to merge.');
  }
  const mergeMode = (raw.mergeMode as (typeof validMergeModes)[number] | undefined) ?? (scratch ? 'no_op' : undefined);
  const reviewProvider = raw.reviewProvider ?? (raw.mergeMode === 'external_review' ? 'github' : undefined);

  if (scratch && raw.repoUrl !== undefined) {
    throw new PlanParseError('Plan cannot set both "scratch: true" and "repoUrl" — scratch plans run with no git repo.');
  }
  if (!scratch && (!raw.repoUrl || typeof raw.repoUrl !== 'string')) {
    throw new PlanParseError('Plan must have either a "repoUrl" field (e.g. repoUrl: git@github.com:user/repo.git) or "scratch: true" (no-repo mode).');
  }
  if (raw.intermediateRepoUrl !== undefined) {
    if (typeof raw.intermediateRepoUrl !== 'string' || raw.intermediateRepoUrl.trim() === '') {
      throw new PlanParseError('Plan "intermediateRepoUrl" must be a non-empty string when provided.');
    }
    raw.intermediateRepoUrl = raw.intermediateRepoUrl.trim();
  }

  const topLevelExternalDependencies = parseExternalDependencies('Plan', raw.externalDependencies);
  const seenTaskIds = new Set<string>();
  const tasks = raw.tasks.map((task, index) => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      throw new PlanParseError(`Task at index ${index} must be an object with an "id" field`);
    }
    if (!task.id || typeof task.id !== 'string') throw new PlanParseError(`Task at index ${index} must have an "id" field`);
    if (seenTaskIds.has(task.id)) {
      throw new PlanParseError(`Duplicate task id "${task.id}". Task ids must be unique within a plan.`);
    }
    seenTaskIds.add(task.id);
    if (!task.description || typeof task.description !== 'string') {
      throw new PlanParseError(`Task "${task.id}" must have a "description" field`);
    }
    assertNoLegacyRoutingKeys(`Task "${task.id}"`, task as object);
    if (hasOwn(task as object, 'autoFix')) {
      throw new PlanParseError(`Task "${task.id}" uses "autoFix", which is no longer supported in plan YAML. Configure "~/.invoker/config.json" with "autoFixRetries" instead.`);
    }
    if (hasOwn(task as object, 'autoFixRetries')) {
      throw new PlanParseError(`Task "${task.id}" uses "autoFixRetries", which is no longer supported in plan YAML. Configure "~/.invoker/config.json" with "autoFixRetries" instead.`);
    }
    if (task.command && /\bnpx vitest run\b/.test(task.command)) {
      throw new PlanParseError(`Task "${task.id}" uses 'npx vitest run' which may not resolve correctly. Use 'pnpm test' instead.`);
    }
    if (scratch && (task.dockerImage || task.poolId)) {
      throw new PlanParseError(`Task "${task.id}" sets "dockerImage"/"poolId" but the plan has "scratch: true" — scratch tasks always run in a plain temp directory.`);
    }

    if (task.externalDependencies !== undefined) {
      throw new PlanParseError(
        `Task "${task.id}" uses task-level "externalDependencies", which is no longer supported. ` +
        'Put cross-workflow dependencies at the plan/workflow level.',
      );
    }

    if (task.executionModel !== undefined && typeof task.executionModel !== 'string') {
      throw new PlanParseError(`Task "${task.id}" field "executionModel" must be a string when provided`);
    }

    return {
      id: task.id,
      description: task.description,
      command: task.command,
      prompt: task.prompt,
      dependencies: task.dependencies ?? [],
      pivot: task.pivot,
      experimentVariants: task.experimentVariants?.map((variant) => ({
        id: variant.id ?? '',
        description: variant.description ?? '',
        prompt: variant.prompt,
        command: variant.command,
      })),
      requiresManualApproval: task.requiresManualApproval,
      featureBranch: task.featureBranch,
      dockerImage: task.dockerImage,
      poolId: task.poolId,
      executionAgent: task.executionAgent?.trim() || undefined,
      executionModel: task.executionModel?.trim() || undefined,
    };
  });

  return applyPlanDefinitionDefaults({
    name: raw.name,
    description: raw.description,
    visualProof: raw.visualProof,
    onFinish,
    baseBranch: raw.baseBranch,
    featureBranch: raw.featureBranch,
    mergeMode,
    reviewProvider,
    repoUrl: raw.repoUrl,
    scratch: scratch || undefined,
    intermediateRepoUrl: raw.intermediateRepoUrl,
    externalDependencies: topLevelExternalDependencies,
    tasks,
  });
}

export async function parsePlanFile(filePath: string): Promise<PlanDefinition> {
  const { readFile } = await import('node:fs/promises');
  return parsePlan(await readFile(filePath, 'utf8'));
}
