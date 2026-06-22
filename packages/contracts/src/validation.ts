/**
 * Validation helpers for WorkRequest and WorkResponse.
 * Lightweight runtime checks (no external schema library).
 */

import type { WorkRequest, WorkResponse } from './types.ts';

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validateWorkRequest(req: unknown): ValidationResult {
  if (!req || typeof req !== 'object') {
    return { valid: false, error: 'WorkRequest must be an object' };
  }

  const r = req as Record<string, unknown>;

  if (typeof r.requestId !== 'string' || r.requestId.length === 0) {
    return { valid: false, error: 'requestId is required and must be a non-empty string' };
  }

  if (typeof r.actionId !== 'string' || r.actionId.length === 0) {
    return { valid: false, error: 'actionId is required and must be a non-empty string' };
  }

  if (r.attemptId !== undefined && (typeof r.attemptId !== 'string' || r.attemptId.length === 0)) {
    return { valid: false, error: 'attemptId, if provided, must be a non-empty string' };
  }

  if (!Number.isInteger(r.executionGeneration) || (r.executionGeneration as number) < 0) {
    return { valid: false, error: 'executionGeneration is required and must be a non-negative integer' };
  }

  const validTypes = ['command', 'ai_task', 'reconciliation', 'merge_gate'];
  if (!validTypes.includes(r.actionType as string)) {
    return { valid: false, error: `actionType must be one of: ${validTypes.join(', ')}` };
  }

  if (!r.inputs || typeof r.inputs !== 'object') {
    return { valid: false, error: 'inputs is required and must be an object' };
  }

  if (typeof r.callbackUrl !== 'string' || r.callbackUrl.length === 0) {
    return { valid: false, error: 'callbackUrl is required and must be a non-empty string' };
  }

  return { valid: true };
}

const validReviewGateArtifactStatuses = [
  'pending',
  'open',
  'approved',
  'changes_requested',
  'merged',
  'closed',
  'discarded',
  'unknown',
] as const;

function checkForCycle(dependencies: ReadonlyMap<string, readonly string[]>, ids: Iterable<string>): string | undefined {
  const visitState = new Map<string, 'visiting' | 'visited'>();

  const visit = (id: string): string | undefined => {
    const state = visitState.get(id);
    if (state === 'visiting') {
      return id;
    }
    if (state === 'visited') {
      return undefined;
    }

    visitState.set(id, 'visiting');
    for (const dependency of dependencies.get(id) ?? []) {
      const cycleAt = visit(dependency);
      if (cycleAt) {
        return cycleAt;
      }
    }
    visitState.set(id, 'visited');
    return undefined;
  };

  for (const id of ids) {
    const cycleAt = visit(id);
    if (cycleAt) {
      return cycleAt;
    }
  }

  return undefined;
}

type ReviewGateArtifactsValidationResult =
  | ValidationResult & { valid: false }
  | {
      valid: true;
      ids: Set<string>;
      artifactRecords: Array<Record<string, unknown>>;
    };

function validateReviewGateArtifacts(args: {
  artifacts: readonly unknown[];
  prefix: string;
}): ReviewGateArtifactsValidationResult {
  const ids = new Set<string>();
  const artifactRecords: Array<Record<string, unknown>> = [];

  for (let i = 0; i < args.artifacts.length; i += 1) {
    const artifact = args.artifacts[i];
    const artifactPrefix = `${args.prefix}.artifacts[${i}]`;
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
      return { valid: false, error: `${artifactPrefix} must be an object` };
    }

    const record = artifact as Record<string, unknown>;
    artifactRecords.push(record);
    if (typeof record.id !== 'string' || record.id.length === 0) {
      return { valid: false, error: `${artifactPrefix}.id must be a non-empty string` };
    }
    if (ids.has(record.id)) {
      return { valid: false, error: `${artifactPrefix}.id duplicates artifact "${record.id}"` };
    }
    ids.add(record.id);

    if (typeof record.required !== 'boolean') {
      return { valid: false, error: `${artifactPrefix}.required must be a boolean` };
    }
    if (!validReviewGateArtifactStatuses.includes(record.status as (typeof validReviewGateArtifactStatuses)[number])) {
      return { valid: false, error: `${artifactPrefix}.status must be one of: ${validReviewGateArtifactStatuses.join(', ')}` };
    }
    if (!Number.isInteger(record.generation) || (record.generation as number) < 0) {
      return { valid: false, error: `${artifactPrefix}.generation must be a non-negative integer` };
    }
    if (record.dependsOn !== undefined && !Array.isArray(record.dependsOn)) {
      return { valid: false, error: `${artifactPrefix}.dependsOn must be an array` };
    }
  }

  return { valid: true, ids, artifactRecords };
}



function validateReviewGate(reviewGate: unknown): ValidationResult {
  const prefix = 'outputs.reviewGate';
  if (!reviewGate || typeof reviewGate !== 'object' || Array.isArray(reviewGate)) {
    return { valid: false, error: `${prefix} must be an object` };
  }

  const gate = reviewGate as Record<string, unknown>;
  if (!Number.isInteger(gate.activeGeneration) || (gate.activeGeneration as number) < 0) {
    return { valid: false, error: `${prefix}.activeGeneration must be a non-negative integer` };
  }

  if (!gate.completion || typeof gate.completion !== 'object' || Array.isArray(gate.completion)) {
    return { valid: false, error: `${prefix}.completion must be an object` };
  }
  const completion = gate.completion as Record<string, unknown>;
  if (completion.required !== 'all') {
    return { valid: false, error: `${prefix}.completion.required must be "all"` };
  }
  if (completion.status !== 'approved') {
    return { valid: false, error: `${prefix}.completion.status must be "approved"` };
  }

  if (!Array.isArray(gate.artifacts)) {
    return { valid: false, error: `${prefix}.artifacts must be an array` };
  }

  const validatedArtifacts = validateReviewGateArtifacts({ artifacts: gate.artifacts, prefix });
  if (!validatedArtifacts.valid) {
    return validatedArtifacts;
  }
  const { ids, artifactRecords } = validatedArtifacts;

  const dependencies = new Map<string, string[]>();
  for (let i = 0; i < artifactRecords.length; i += 1) {
    const record = artifactRecords[i];
    const artifactPrefix = `${prefix}.artifacts[${i}]`;
    const id = record.id as string;
    const dependsOn = (record.dependsOn ?? []) as unknown[];
    const artifactDependencies: string[] = [];
    for (const dependency of dependsOn) {
      if (typeof dependency !== 'string' || dependency.length === 0) {
        return { valid: false, error: `${artifactPrefix}.dependsOn must contain non-empty artifact ids` };
      }
      if (!ids.has(dependency)) {
        return { valid: false, error: `${artifactPrefix}.dependsOn references unknown artifact "${dependency}"` };
      }
      if (dependency === id) {
        return { valid: false, error: `${artifactPrefix}.dependsOn must not reference itself` };
      }
      artifactDependencies.push(dependency);
    }
    dependencies.set(id, artifactDependencies);
  }

  const cycleAt = checkForCycle(dependencies, ids);
  if (cycleAt) {
    return { valid: false, error: `${prefix}.artifacts dependency graph has a cycle involving "${cycleAt}"` };
  }

  return { valid: true };
}

export function validateWorkResponse(res: unknown): ValidationResult {
  if (!res || typeof res !== 'object' || Array.isArray(res)) {
    return { valid: false, error: 'WorkResponse must be an object' };
  }

  const r = res as Record<string, unknown>;

  if (typeof r.requestId !== 'string' || r.requestId.length === 0) {
    return { valid: false, error: 'requestId is required and must be a non-empty string' };
  }

  if (typeof r.actionId !== 'string' || r.actionId.length === 0) {
    return { valid: false, error: 'actionId is required and must be a non-empty string' };
  }

  if (r.attemptId !== undefined && (typeof r.attemptId !== 'string' || r.attemptId.length === 0)) {
    return { valid: false, error: 'attemptId, if provided, must be a non-empty string' };
  }

  if (!Number.isInteger(r.executionGeneration) || (r.executionGeneration as number) < 0) {
    return { valid: false, error: 'executionGeneration is required and must be a non-negative integer' };
  }

  const validStatuses = ['completed', 'review_ready', 'failed', 'needs_input', 'spawn_experiments', 'select_experiment'];
  if (!validStatuses.includes(r.status as string)) {
    return { valid: false, error: `status must be one of: ${validStatuses.join(', ')}` };
  }

  if (!r.outputs || typeof r.outputs !== 'object' || Array.isArray(r.outputs)) {
    return { valid: false, error: 'outputs is required and must be an object' };
  }

  // spawn_experiments requires dagMutation.spawnExperiments
  if (r.status === 'spawn_experiments') {
    const dm = r.dagMutation as Record<string, unknown> | undefined;
    if (!dm?.spawnExperiments) {
      return { valid: false, error: 'spawn_experiments status requires dagMutation.spawnExperiments' };
    }
  }

  // select_experiment requires dagMutation.selectExperiment
  if (r.status === 'select_experiment') {
    const dm = r.dagMutation as Record<string, unknown> | undefined;
    if (!dm?.selectExperiment) {
      return { valid: false, error: 'select_experiment status requires dagMutation.selectExperiment' };
    }
  }

  const outputs = r.outputs as Record<string, unknown>;
  if (outputs.reviewGate !== undefined) {
    const reviewGateValidation = validateReviewGate(outputs.reviewGate);
    if (!reviewGateValidation.valid) {
      return reviewGateValidation;
    }
  }

  return { valid: true };
}
