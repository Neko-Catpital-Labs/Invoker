import { execFileSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import type { PlanDefinition } from './orchestrator.js';

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
  intermediateRepoUrl?: string;
  externalDependencies?: Array<{
    workflowId?: string;
    taskId?: string;
    requiredStatus?: string;
    gatePolicy?: string;
  }>;
  tasks?: RawPlanTask[];
}

function detectDefaultBranchRemote(repoUrl: string): string {
  try {
    const output = execFileSync('git', ['ls-remote', '--symref', repoUrl, 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
    const match = output.match(/ref:\s+refs\/heads\/(\S+)\s+HEAD/);
    if (match) return match[1];
  } catch {
    // Network and local-path failures fall back to the common default.
  }
  return 'main';
}

function resolveDefaultBaseBranch(plan: PlanDefinition): string {
  const branch = plan.baseBranch;
  if (typeof branch === 'string' && branch.trim() !== '') return branch.trim();
  return plan.repoUrl ? detectDefaultBranchRemote(plan.repoUrl) : 'main';
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

  const validOnFinishValues = ['none', 'merge', 'pull_request'] as const;
  if (raw.onFinish !== undefined && !validOnFinishValues.includes(raw.onFinish as any)) {
    throw new PlanParseError(`"onFinish" must be one of: ${validOnFinishValues.join(', ')}. Got: "${raw.onFinish}"`);
  }
  const onFinish = (raw.onFinish as (typeof validOnFinishValues)[number]) ?? 'pull_request';

  const validMergeModes = ['manual', 'automatic', 'external_review'] as const;
  if (raw.mergeMode !== undefined && !validMergeModes.includes(raw.mergeMode as any)) {
    throw new PlanParseError(`"mergeMode" must be one of: ${validMergeModes.join(', ')}. Got: "${raw.mergeMode}"`);
  }
  const mergeMode = raw.mergeMode as (typeof validMergeModes)[number] | undefined;
  const reviewProvider = raw.reviewProvider ?? (raw.mergeMode === 'external_review' ? 'github' : undefined);

  if (!raw.repoUrl || typeof raw.repoUrl !== 'string') {
    throw new PlanParseError('Plan must have a "repoUrl" field (e.g. repoUrl: git@github.com:user/repo.git).');
  }
  if (raw.intermediateRepoUrl !== undefined) {
    if (typeof raw.intermediateRepoUrl !== 'string' || raw.intermediateRepoUrl.trim() === '') {
      throw new PlanParseError('Plan "intermediateRepoUrl" must be a non-empty string when provided.');
    }
    raw.intermediateRepoUrl = raw.intermediateRepoUrl.trim();
  }

  const topLevelExternalDependencies = parseExternalDependencies('Plan', raw.externalDependencies);
  const tasks = raw.tasks.map((task, index) => {
    if (!task.id || typeof task.id !== 'string') throw new PlanParseError(`Task at index ${index} must have an "id" field`);
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

    if (task.externalDependencies !== undefined) {
      throw new PlanParseError(
        `Task "${task.id}" uses task-level "externalDependencies", which is no longer supported. ` +
        'Put cross-workflow dependencies at the plan/workflow level.',
      );
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
    intermediateRepoUrl: raw.intermediateRepoUrl,
    externalDependencies: topLevelExternalDependencies,
    tasks,
  });
}

export async function parsePlanFile(filePath: string): Promise<PlanDefinition> {
  const { readFile } = await import('node:fs/promises');
  return parsePlan(await readFile(filePath, 'utf8'));
}
