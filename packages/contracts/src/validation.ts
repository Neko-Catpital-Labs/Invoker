/**
 * Validation helpers for WorkRequest and WorkResponse.
 * Lightweight runtime checks (no external schema library).
 */

import type { WorkRequest, WorkResponse } from './types.js';

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

  const validTypes = ['command', 'ai_task', 'reconciliation'];
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

  const validStatuses = ['completed', 'failed', 'needs_input', 'spawn_experiments', 'select_experiment'];
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

  return { valid: true };
}
