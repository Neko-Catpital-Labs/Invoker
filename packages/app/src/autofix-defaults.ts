import type { InvokerConfig } from './config.js';

export const DEFAULT_AUTO_FIX_RETRIES = 3;

export const DEFAULT_AUTO_APPROVE_AI_FIXES = true;

export function resolveAutoFixRetries(config: InvokerConfig): number {
  const value = config.autoFixRetries;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return DEFAULT_AUTO_FIX_RETRIES;
}

export function resolveAutoApproveAIFixes(config: InvokerConfig): boolean {
  const value = config.autoApproveAIFixes;
  if (typeof value === 'boolean') {
    return value;
  }
  return DEFAULT_AUTO_APPROVE_AI_FIXES;
}
