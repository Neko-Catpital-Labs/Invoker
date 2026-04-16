/**
 * Plan Parser — Reads YAML plan files into PlanDefinition objects.
 *
 * Validates required fields: name, tasks (non-empty), task.id, task.description.
 * Uses the `yaml` npm package for parsing.
 */

import { execSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import type { PlanDefinition } from '@invoker/workflow-core';
import { loadConfig } from './config.js';
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
  executorType?: string;
  dockerImage?: string;
  remoteTargetId?: string;
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
  executorType?: string;
  externalDependencies?: Array<{
    workflowId?: string;
    taskId?: string;
    requiredStatus?: string;
    gatePolicy?: string;
  }>;
  tasks?: RawPlanTask[];
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
    return {
      workflowId: dep.workflowId,
      taskId,
      requiredStatus: 'completed' as const,
      gatePolicy: (dep.gatePolicy ?? 'review_ready') as 'completed' | 'review_ready',
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

/**
 * Parse a YAML string into a validated PlanDefinition.
 * Throws PlanParseError if validation fails.
 */
export function parsePlan(yamlContent: string): PlanDefinition {
  const raw = parseYaml(yamlContent) as RawPlan;

  if (!raw || typeof raw !== 'object') {
    throw new PlanParseError('Plan must be a YAML object');
  }

  if (!raw.name || typeof raw.name !== 'string') {
    throw new PlanParseError('Plan must have a "name" field');
  }

  if (!raw.tasks || !Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    throw new PlanParseError('Plan must have a non-empty "tasks" array');
  }

  const hasOwn = (obj: object, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(obj, key);

  if (hasOwn(raw as object, 'autoFix')) {
    throw new PlanParseError(
      'Plan-level "autoFix" is no longer supported. Configure "~/.invoker/config.json" with "autoFixRetries" instead.',
    );
  }
  if (hasOwn(raw as object, 'autoFixRetries')) {
    throw new PlanParseError(
      'Plan-level "autoFixRetries" is no longer supported. Configure "~/.invoker/config.json" with "autoFixRetries" instead.',
    );
  }

  // Validate onFinish
  const validOnFinishValues = ['none', 'merge', 'pull_request'] as const;
  if (raw.onFinish !== undefined && !validOnFinishValues.includes(raw.onFinish as any)) {
    throw new PlanParseError(
      `"onFinish" must be one of: ${validOnFinishValues.join(', ')}. Got: "${raw.onFinish}"`,
    );
  }
  const onFinish = (raw.onFinish as (typeof validOnFinishValues)[number]) ?? 'pull_request';

  // Validate mergeMode — accept 'github' for backward compat, normalize to 'external_review'
  const validMergeModes = ['manual', 'automatic', 'github', 'external_review'] as const;
  if (raw.mergeMode !== undefined && !validMergeModes.includes(raw.mergeMode as any)) {
    throw new PlanParseError(
      `"mergeMode" must be one of: ${validMergeModes.join(', ')}. Got: "${raw.mergeMode}"`,
    );
  }
  const rawMergeMode = raw.mergeMode as (typeof validMergeModes)[number] | undefined;
  const mergeMode = rawMergeMode !== undefined
    ? normalizeMergeModeForPersistence(rawMergeMode)
    : undefined;

  // Default reviewProvider to 'github' when mergeMode was 'github' or 'external_review'
  const reviewProvider = raw.reviewProvider
    ?? ((rawMergeMode === 'github' || rawMergeMode === 'external_review') ? 'github' : undefined);

  // Auto-generate featureBranch from plan name when not explicitly specified
  if (!raw.featureBranch) {
    const slug = (raw.name as string).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    raw.featureBranch = `plan/${slug}`;
  }

  // Require plan-level repoUrl
  if (!raw.repoUrl || typeof raw.repoUrl !== 'string') {
    throw new PlanParseError(
      'Plan must have a "repoUrl" field (e.g. repoUrl: git@github.com:user/repo.git).',
    );
  }

  const defaultExecutorType = raw.executorType;
  const topLevelExternalDependencies = parseExternalDependencies('Plan', raw.externalDependencies);

  const tasks = raw.tasks.map((task, index) => {
    if (!task.id || typeof task.id !== 'string') {
      throw new PlanParseError(`Task at index ${index} must have an "id" field`);
    }

    if (!task.description || typeof task.description !== 'string') {
      throw new PlanParseError(`Task "${task.id}" must have a "description" field`);
    }

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

    const taskExternalDependencies = parseExternalDependencies(`Task "${task.id}"`, task.externalDependencies);
    const isRootTask = (task.dependencies?.length ?? 0) === 0;
    const externalDependencies = mergeExternalDependencies(
      isRootTask ? topLevelExternalDependencies : undefined,
      taskExternalDependencies,
    );

    // Parse experiment variants if present
    const experimentVariants = task.experimentVariants?.map((v) => ({
      id: v.id ?? '',
      description: v.description ?? '',
      prompt: v.prompt,
      command: v.command,
    }));

    const resolvedExecutorType = task.executorType ?? defaultExecutorType;

    if (resolvedExecutorType === 'docker' && !task.dockerImage) {
      throw new PlanParseError(
        `Task "${task.id}" has executorType "docker" but is missing required field "dockerImage"`,
      );
    }
    if (resolvedExecutorType === 'ssh' && !task.remoteTargetId) {
      throw new PlanParseError(
        `Task "${task.id}" has executorType "ssh" but is missing required field "remoteTargetId"`,
      );
    }

    return {
      id: task.id,
      description: task.description,
      command: task.command,
      prompt: task.prompt,
      dependencies: task.dependencies ?? [],
      externalDependencies,
      pivot: task.pivot,
      experimentVariants,
      requiresManualApproval: task.requiresManualApproval,
      featureBranch: task.featureBranch,
      executorType: resolvedExecutorType,
      dockerImage: task.dockerImage,
      remoteTargetId: task.remoteTargetId,
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
    tasks,
  });
}

/**
 * Parse a YAML plan file from disk.
 */
export async function parsePlanFile(filePath: string): Promise<PlanDefinition> {
  const { readFile } = await import('node:fs/promises');
  const content = await readFile(filePath, 'utf-8');
  return parsePlan(content);
}
