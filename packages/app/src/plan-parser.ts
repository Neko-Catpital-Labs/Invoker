/**
 * Plan Parser — Reads YAML plan files into PlanDefinition objects.
 *
 * Validates required fields: name, tasks (non-empty), task.id, task.description.
 * Uses the `yaml` npm package for parsing.
 */

import { execSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import type { PlanDefinition } from '@invoker/workflow-core';
import { loadConfig, resolveDefaultExecutionAgent } from './config.js';
import { normalizeMergeModeForPersistence } from './merge-mode.js';

/** Empty / whitespace `baseBranch` in YAML (`baseBranch:`) must fall through to config + remote detection like a missing key. */
function resolveDefaultBaseBranch(plan: PlanDefinition): string {
  const b = plan.baseBranch;
  if (typeof b === 'string' && b.trim() !== '') return b.trim();
  return loadConfig().defaultBranch ?? (plan.repoUrl ? detectDefaultBranchRemote(plan.repoUrl) : 'main');
}

/**
 * Top-level plan defaults aligned with {@link parsePlan} (merge target, feature branch, onFinish).
 * Use when a {@link PlanDefinition} is built outside the YAML parser — e.g. GUI `yaml.load` + IPC.
 */
export function applyPlanDefinitionDefaults(plan: PlanDefinition): PlanDefinition {
  const slug = plan.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const fb = plan.featureBranch;
  const featureBranch = typeof fb === 'string' && fb.trim() !== '' ? fb.trim() : `plan/${slug}`;

  return {
    ...plan,
    onFinish: plan.onFinish ?? 'pull_request',
    baseBranch: resolveDefaultBaseBranch(plan),
    featureBranch,
  };
}
function taskNeedsDefaultExecutionAgent(task: PlanDefinition['tasks'][number]): boolean {
  if (typeof task.prompt === 'string' && task.prompt.trim() !== '') return true;
  return task.experimentVariants?.some((variant) => (
    typeof variant.prompt === 'string' && variant.prompt.trim() !== ''
  )) ?? false;
}

export function applyPlanExecutionAgentDefault(plan: PlanDefinition, executionAgent: string): PlanDefinition {
  const defaultExecutionAgent = executionAgent.trim();
  if (!defaultExecutionAgent) return plan;
  return {
    ...plan,
    tasks: plan.tasks.map((task) => {
      if (task.executionAgent?.trim() || !taskNeedsDefaultExecutionAgent(task)) {
        return task;
      }
      return { ...task, executionAgent: defaultExecutionAgent };
    }),
  };
}

export function applyConfiguredPlanDefaults(plan: PlanDefinition): PlanDefinition {
  return applyPlanExecutionAgentDefault(plan, resolveDefaultExecutionAgent(loadConfig()));
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
  intermediateRepoUrl?: string;
  externalDependencies?: Array<{
    workflowId?: string;
    taskId?: string;
    requiredStatus?: string;
    gatePolicy?: string;
  }>;
  tasks?: RawPlanTask[];
}

export interface RawPlanBundle extends RawPlan {
  workflows?: RawPlan[];
}

export interface PlanSubmissionBundle {
  name: string;
  plans: PlanDefinition[];
  isStack: boolean;
}

/**
 * Auto-detect the repo's default branch via git.
 * Tries origin/HEAD first, then checks if 'main' exists locally, falls back to 'master'.
 */
export function detectDefaultBranch(cwd?: string): string {
  try {
    const ref = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return ref.replace('refs/remotes/origin/', '');
  } catch {
    try {
      execSync('git rev-parse --verify main', {
        cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
      return 'main';
    } catch {
      return 'master';
    }
  }
}

/**
 * Detect the default branch from a remote URL using `git ls-remote --symref`.
 * Falls back to 'main' if detection fails.
 */
export function detectDefaultBranchRemote(repoUrl: string): string {
  try {
    const output = execSync(`git ls-remote --symref ${repoUrl} HEAD`, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000,
    }).trim();
    // Output format: "ref: refs/heads/main\tHEAD"
    const match = output.match(/ref:\s+refs\/heads\/(\S+)\s+HEAD/);
    if (match) return match[1];
  } catch {
    // Network error or timeout
  }
  return 'main';
}

export class PlanParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanParseError';
  }
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
      throw new PlanParseError(
        `${ownerLabel} externalDependencies[${depIndex}] must have a string "workflowId"`,
      );
    }
    if (dep.taskId !== undefined && typeof dep.taskId !== 'string') {
      throw new PlanParseError(
        `${ownerLabel} externalDependencies[${depIndex}] "taskId" must be a string when provided`,
      );
    }
    if (dep.requiredStatus !== undefined && dep.requiredStatus !== 'completed') {
      throw new PlanParseError(
        `${ownerLabel} externalDependencies[${depIndex}] "requiredStatus" must be "completed"`,
      );
    }
    if (dep.gatePolicy !== undefined && dep.gatePolicy !== 'completed' && dep.gatePolicy !== 'review_ready') {
      if (dep.gatePolicy === 'approved') {
        throw new PlanParseError(
          `gatePolicy value 'approved' is no longer supported. Use 'completed' instead.`,
        );
      }
      throw new PlanParseError(
        `${ownerLabel} externalDependencies[${depIndex}] "gatePolicy" must be "completed" or "review_ready"`,
      );
    }
    const taskId = dep.taskId?.trim() || '__merge__';
    const defaultGatePolicy: 'completed' | 'review_ready' = 'review_ready';
    return {
      workflowId: dep.workflowId,
      taskId,
      requiredStatus: 'completed' as const,
      gatePolicy: (dep.gatePolicy ?? defaultGatePolicy) as 'completed' | 'review_ready',
    };
  });
}

function mergeExternalDependencies(
  inheritedDeps: ParsedExternalDependency[] | undefined,
  taskDeps: ParsedExternalDependency[] | undefined,
): ParsedExternalDependency[] | undefined {
  if (!inheritedDeps && !taskDeps) return undefined;
  const merged = new Map<string, ParsedExternalDependency>();
  for (const dep of inheritedDeps ?? []) {
    merged.set(`${dep.workflowId}::${dep.taskId}`, dep);
  }
  for (const dep of taskDeps ?? []) {
    // Task-level declarations override inherited workflow-level defaults.
    merged.set(`${dep.workflowId}::${dep.taskId}`, dep);
  }
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

/**
 * Parse a YAML string into a validated PlanDefinition.
 * Throws PlanParseError if validation fails.
 */
function parseRawPlan(raw: RawPlan, ownerLabel = 'Plan'): PlanDefinition {
  if (!raw || typeof raw !== 'object') {
    throw new PlanParseError(`${ownerLabel} must be a YAML object`);
  }

  if (!raw.name || typeof raw.name !== 'string') {
    throw new PlanParseError(`${ownerLabel} must have a "name" field`);
  }

  if (!raw.tasks || !Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    throw new PlanParseError(`${ownerLabel} must have a non-empty "tasks" array`);
  }

  const hasOwn = (obj: object, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(obj, key);

  if (hasOwn(raw as object, 'autoFix')) {
    throw new PlanParseError(
      `${ownerLabel}-level "autoFix" is no longer supported. Configure "~/.invoker/config.json" with "autoFixRetries" instead.`,
    );
  }
  if (hasOwn(raw as object, 'autoFixRetries')) {
    throw new PlanParseError(
      `${ownerLabel}-level "autoFixRetries" is no longer supported. Configure "~/.invoker/config.json" with "autoFixRetries" instead.`,
    );
  }
  assertNoLegacyRoutingKeys(ownerLabel, raw as object);

  const validOnFinishValues = ['none', 'merge', 'pull_request'] as const;
  if (raw.onFinish !== undefined && !validOnFinishValues.includes(raw.onFinish as any)) {
    throw new PlanParseError(
      `"onFinish" must be one of: ${validOnFinishValues.join(', ')}. Got: "${raw.onFinish}"`,
    );
  }
  const onFinish = (raw.onFinish as (typeof validOnFinishValues)[number]) ?? 'pull_request';

  const validMergeModes = ['manual', 'automatic', 'external_review'] as const;
  if (raw.mergeMode !== undefined && !validMergeModes.includes(raw.mergeMode as any)) {
    throw new PlanParseError(
      `"mergeMode" must be one of: ${validMergeModes.join(', ')}. Got: "${raw.mergeMode}"`,
    );
  }
  const rawMergeMode = raw.mergeMode as (typeof validMergeModes)[number] | undefined;
  const mergeMode = rawMergeMode !== undefined
    ? normalizeMergeModeForPersistence(rawMergeMode)
    : undefined;

  const reviewProvider = raw.reviewProvider
    ?? (rawMergeMode === 'external_review' ? 'github' : undefined);

  if (!raw.featureBranch) {
    const slug = raw.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    raw.featureBranch = `plan/${slug}`;
  }

  if (!raw.repoUrl || typeof raw.repoUrl !== 'string') {
    throw new PlanParseError(
      `${ownerLabel} must have a "repoUrl" field (e.g. repoUrl: git@github.com:user/repo.git).`,
    );
  }
  if (raw.intermediateRepoUrl !== undefined) {
    if (typeof raw.intermediateRepoUrl !== 'string' || raw.intermediateRepoUrl.trim() === '') {
      throw new PlanParseError(
        `${ownerLabel} "intermediateRepoUrl" must be a non-empty string when provided.`,
      );
    }
    raw.intermediateRepoUrl = raw.intermediateRepoUrl.trim();
  }

  const topLevelExternalDependencies = parseExternalDependencies(ownerLabel, raw.externalDependencies);

  const seenTaskIds = new Set<string>();
  const tasks = raw.tasks.map((task, index) => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      throw new PlanParseError(`Task at index ${index} must be an object with an "id" field`);
    }
    if (!task.id || typeof task.id !== 'string') {
      throw new PlanParseError(`Task at index ${index} must have an "id" field`);
    }
    if (seenTaskIds.has(task.id)) {
      throw new PlanParseError(`Duplicate task id "${task.id}". Task ids must be unique within a plan.`);
    }
    seenTaskIds.add(task.id);

    if (!task.description || typeof task.description !== 'string') {
      throw new PlanParseError(`Task "${task.id}" must have a "description" field`);
    }
    assertNoLegacyRoutingKeys(`Task "${task.id}"`, task as object);

    if (hasOwn(task as object, 'autoFix')) {
      throw new PlanParseError(
        `Task "${task.id}" uses "autoFix", which is no longer supported in plan YAML. ` +
        'Configure "~/.invoker/config.json" with "autoFixRetries" instead.',
      );
    }
    if (hasOwn(task as object, 'autoFixRetries')) {
      throw new PlanParseError(
        `Task "${task.id}" uses "autoFixRetries", which is no longer supported in plan YAML. ` +
        'Configure "~/.invoker/config.json" with "autoFixRetries" instead.',
      );
    }

    if (task.command && /\bnpx vitest run\b/.test(task.command)) {
      throw new PlanParseError(
        `Task "${task.id}" uses 'npx vitest run' which may not resolve correctly. ` +
        `Use 'pnpm test' instead.`,
      );
    }

    if (task.externalDependencies !== undefined) {
      throw new PlanParseError(
        `Task "${task.id}" uses task-level "externalDependencies", which is no longer supported. ` +
        'Put cross-workflow dependencies at the plan/workflow level.',
      );
    }

    const experimentVariants = task.experimentVariants?.map((v) => ({
      id: v.id ?? '',
      description: v.description ?? '',
      prompt: v.prompt,
      command: v.command,
    }));

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
      experimentVariants,
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
    intermediateRepoUrl: raw.intermediateRepoUrl,
    externalDependencies: topLevelExternalDependencies,
    tasks,
  });
}

function inheritStackWorkflowDefaults(stack: RawPlanBundle, workflow: RawPlan): RawPlan {
  const stackExternalDependencies = stack.externalDependencies === undefined
    ? []
    : Array.isArray(stack.externalDependencies)
      ? stack.externalDependencies
      : (() => {
          throw new PlanParseError('Plan stack "externalDependencies" must be an array when provided.');
        })();
  const workflowExternalDependencies = workflow.externalDependencies === undefined
    ? []
    : Array.isArray(workflow.externalDependencies)
      ? workflow.externalDependencies
      : (() => {
          throw new PlanParseError(`Workflow "${workflow.name ?? '<unnamed>'}" "externalDependencies" must be an array when provided.`);
        })();
  const externalDependencies = [
    ...stackExternalDependencies,
    ...workflowExternalDependencies,
  ];

  return {
    ...workflow,
    repoUrl: workflow.repoUrl ?? stack.repoUrl,
    intermediateRepoUrl: workflow.intermediateRepoUrl ?? stack.intermediateRepoUrl,
    onFinish: workflow.onFinish ?? stack.onFinish,
    baseBranch: workflow.baseBranch ?? stack.baseBranch,
    mergeMode: workflow.mergeMode ?? stack.mergeMode,
    reviewProvider: workflow.reviewProvider ?? stack.reviewProvider,
    visualProof: workflow.visualProof ?? stack.visualProof,
    externalDependencies: externalDependencies.length > 0 ? externalDependencies : workflow.externalDependencies,
  };
}

export function parsePlanSubmissionBundle(yamlContent: string): PlanSubmissionBundle {
  const raw = parseYaml(yamlContent) as RawPlanBundle;

  if (!raw || typeof raw !== 'object') {
    throw new PlanParseError('Plan must be a YAML object');
  }

  if (raw.workflows === undefined) {
    const plan = parseRawPlan(raw, 'Plan');
    return { name: plan.name, plans: [plan], isStack: false };
  }

  if (!raw.name || typeof raw.name !== 'string') {
    throw new PlanParseError('Plan stack must have a "name" field');
  }
  if (!Array.isArray(raw.workflows) || raw.workflows.length === 0) {
    throw new PlanParseError('Plan stack must have a non-empty "workflows" array');
  }
  if (raw.tasks !== undefined) {
    throw new PlanParseError('Plan stack must put tasks inside each workflow, not at the top level.');
  }
  const stackHasOwn = (key: string): boolean =>
    Object.prototype.hasOwnProperty.call(raw as object, key);
  if (stackHasOwn('autoFix')) {
    throw new PlanParseError(
      'Plan stack-level "autoFix" is no longer supported. Configure "~/.invoker/config.json" with "autoFixRetries" instead.',
    );
  }
  if (stackHasOwn('autoFixRetries')) {
    throw new PlanParseError(
      'Plan stack-level "autoFixRetries" is no longer supported. Configure "~/.invoker/config.json" with "autoFixRetries" instead.',
    );
  }
  assertNoLegacyRoutingKeys('Plan stack', raw as object);

  const plans = raw.workflows.map((workflow, index) => {
    if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
      throw new PlanParseError(`Workflow at index ${index} must be an object with a "name" field`);
    }
    return parseRawPlan(inheritStackWorkflowDefaults(raw, workflow), `Workflow ${index + 1}`);
  });

  return { name: raw.name, plans, isStack: true };
}

export function parsePlan(yamlContent: string): PlanDefinition {
  const submission = parsePlanSubmissionBundle(yamlContent);
  if (submission.isStack) {
    throw new PlanParseError('Stacked workflow YAML must be loaded with parsePlanSubmissionBundle().');
  }
  return submission.plans[0];
}

/**
 * Parse a YAML plan file from disk.
 */
export async function parsePlanFile(filePath: string): Promise<PlanDefinition> {
  const { readFile } = await import('node:fs/promises');
  const content = await readFile(filePath, 'utf-8');
  return parsePlan(content);
}
