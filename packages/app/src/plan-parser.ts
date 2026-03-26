/**
 * Plan Parser — Reads YAML plan files into PlanDefinition objects.
 *
 * Validates required fields: name, tasks (non-empty), task.id, task.description.
 * Uses the `yaml` npm package for parsing.
 */

import { execSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import type { PlanDefinition } from '@invoker/core';
import { UTILIZATION_MAX } from '@invoker/core';
import { loadConfig } from './config.js';

/** Empty / whitespace `baseBranch` in YAML (`baseBranch:`) must fall through to config + git like a missing key. */
function resolveDefaultBaseBranch(plan: PlanDefinition, dir: string): string {
  const b = plan.baseBranch;
  if (typeof b === 'string' && b.trim() !== '') return b.trim();
  return loadConfig(dir).defaultBranch ?? detectDefaultBranch(dir);
}

/**
 * Top-level plan defaults aligned with {@link parsePlan} (merge target, feature branch, onFinish).
 * Use when a {@link PlanDefinition} is built outside the YAML parser — e.g. GUI `yaml.load` + IPC.
 */
export function applyPlanDefinitionDefaults(plan: PlanDefinition, repoDir?: string): PlanDefinition {
  const dir = repoDir ?? process.cwd();
  const slug = plan.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const fb = plan.featureBranch;
  const featureBranch = typeof fb === 'string' && fb.trim() !== '' ? fb.trim() : `plan/${slug}`;

  // Inherit plan-level repoUrl onto tasks that don't specify their own
  const tasks = plan.repoUrl
    ? plan.tasks.map(t => t.repoUrl ? t : { ...t, repoUrl: plan.repoUrl })
    : plan.tasks;

  return {
    ...plan,
    onFinish: plan.onFinish ?? 'pull_request',
    baseBranch: resolveDefaultBaseBranch(plan, dir),
    featureBranch,
    tasks,
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
  pivot?: boolean;
  experimentVariants?: RawExperimentVariant[];
  requiresManualApproval?: boolean;
  repoUrl?: string;
  featureBranch?: string;
  familiarType?: string;
  dockerImage?: string;
  remoteTargetId?: string;
  autoFix?: boolean;
  maxFixAttempts?: number;
  utilization?: number | 'max';
}

export interface RawPlan {
  name?: string;
  description?: string;
  visualProof?: boolean;
  onFinish?: string;
  baseBranch?: string;
  featureBranch?: string;
  mergeMode?: string;
  repoUrl?: string;
  familiarType?: string;
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

export class PlanParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanParseError';
  }
}

/**
 * Parse a YAML string into a validated PlanDefinition.
 * Throws PlanParseError if validation fails.
 */
export function parsePlan(yamlContent: string, repoDir?: string): PlanDefinition {
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

  // Validate onFinish
  const validOnFinishValues = ['none', 'merge', 'pull_request'] as const;
  if (raw.onFinish !== undefined && !validOnFinishValues.includes(raw.onFinish as any)) {
    throw new PlanParseError(
      `"onFinish" must be one of: ${validOnFinishValues.join(', ')}. Got: "${raw.onFinish}"`,
    );
  }
  const onFinish = (raw.onFinish as (typeof validOnFinishValues)[number]) ?? 'pull_request';

  // Validate mergeMode
  const validMergeModes = ['manual', 'automatic', 'github'] as const;
  if (raw.mergeMode !== undefined && !validMergeModes.includes(raw.mergeMode as any)) {
    throw new PlanParseError(
      `"mergeMode" must be one of: ${validMergeModes.join(', ')}. Got: "${raw.mergeMode}"`,
    );
  }
  const mergeMode = raw.mergeMode as (typeof validMergeModes)[number] | undefined;

  // Auto-generate featureBranch from plan name when not explicitly specified
  if (!raw.featureBranch) {
    const slug = (raw.name as string).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    raw.featureBranch = `plan/${slug}`;
  }

  // Top-level defaults that tasks inherit when not overridden
  const defaultRepoUrl = raw.repoUrl;
  const defaultFamiliarType = raw.familiarType;

  const tasks = raw.tasks.map((task, index) => {
    if (!task.id || typeof task.id !== 'string') {
      throw new PlanParseError(`Task at index ${index} must have an "id" field`);
    }

    if (!task.description || typeof task.description !== 'string') {
      throw new PlanParseError(`Task "${task.id}" must have a "description" field`);
    }

    if (task.command && /\bnpx vitest run\b/.test(task.command)) {
      throw new PlanParseError(
        `Task "${task.id}" uses 'npx vitest run' which may not resolve correctly. ` +
        `Use 'pnpm test' instead.`,
      );
    }

    // Parse experiment variants if present
    const experimentVariants = task.experimentVariants?.map((v) => ({
      id: v.id ?? '',
      description: v.description ?? '',
      prompt: v.prompt,
      command: v.command,
    }));

    return {
      id: task.id,
      description: task.description,
      command: task.command,
      prompt: task.prompt,
      dependencies: task.dependencies ?? [],
      pivot: task.pivot,
      experimentVariants,
      requiresManualApproval: task.requiresManualApproval,
      repoUrl: task.repoUrl ?? defaultRepoUrl,
      featureBranch: task.featureBranch,
      familiarType: task.familiarType ?? defaultFamiliarType,
      dockerImage: task.dockerImage,
      remoteTargetId: task.remoteTargetId,
      autoFix: task.autoFix,
      maxFixAttempts: task.maxFixAttempts,
      utilization: task.utilization === 'max' ? UTILIZATION_MAX : task.utilization,
    };
  });

  // SSH command tasks require repoUrl to clone the repo on the remote host
  for (const task of tasks) {
    if (task.familiarType === 'ssh' && task.command && !task.repoUrl) {
      throw new PlanParseError(
        `Task "${task.id}" uses familiarType "ssh" with a command but has no repoUrl. ` +
        `Add a top-level "repoUrl" to your plan YAML (e.g. repoUrl: git@github.com:user/repo.git).`,
      );
    }
  }

  return applyPlanDefinitionDefaults({
    name: raw.name,
    description: raw.description,
    visualProof: raw.visualProof,
    onFinish,
    baseBranch: raw.baseBranch,
    featureBranch: raw.featureBranch,
    mergeMode,
    repoUrl: raw.repoUrl,
    tasks,
  }, repoDir);
}

/**
 * Parse a YAML plan file from disk.
 */
export async function parsePlanFile(filePath: string, repoDir?: string): Promise<PlanDefinition> {
  const { readFile } = await import('node:fs/promises');
  const content = await readFile(filePath, 'utf-8');
  return parsePlan(content, repoDir);
}
