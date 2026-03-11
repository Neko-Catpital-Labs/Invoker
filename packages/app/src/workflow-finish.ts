/**
 * Pure logic for determining whether onFinish should run.
 * Separated from main.ts to avoid Electron imports in tests.
 */

export interface WorkflowStatus {
  running: number;
  pending: number;
  failed: number;
  total: number;
}

export interface MergeConfig {
  onFinish?: 'none' | 'merge' | 'pull_request';
  baseBranch?: string;
  featureBranch?: string;
  name?: string;
}

export function shouldRunOnFinish(
  status: WorkflowStatus,
  config: MergeConfig | null,
): boolean {
  if (!config) return false;
  if (status.total === 0) return false;
  if (status.running > 0 || status.pending > 0) return false;
  if (status.failed > 0) return false;
  return config.onFinish !== undefined && config.onFinish !== 'none';
}
