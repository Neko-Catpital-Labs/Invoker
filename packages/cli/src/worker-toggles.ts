import type { InvokerConfigRecord } from '@invoker/contracts';

/**
 * Dotted config paths for the workers this wizard exposes as on/off toggles.
 * Every path is backed by a real `InvokerConfig` field read at owner boot —
 * never a bare env var — see onboarding-invariants.ts's
 * assertWorkerToggleHasSingleConfigSource for the guard against that drifting.
 */
export type WorkerToggleConfigPath =
  | 'prMaintenance.enabled'
  | 'e2eAutoFixEnabled'
  | 'autoApproveAIFixes'
  | 'diskHeadroom.cleanupEnabled';

export interface WorkerToggleSpec {
  id: string;
  label: string;
  description: string;
  configPath: WorkerToggleConfigPath;
}

export const ONBOARDING_WORKER_TOGGLES: readonly WorkerToggleSpec[] = [
  {
    id: 'pr-maintenance',
    label: 'PR maintenance',
    description: 'Babysits open PRs: re-queues stuck merges, closes duplicates, repairs orphaned stack fragments.',
    configPath: 'prMaintenance.enabled',
  },
  {
    id: 'e2e-autofix',
    label: 'E2E auto-fix',
    description: 'Runs the extended test battery on a schedule and opens a fix PR when it finds a failing suite.',
    configPath: 'e2eAutoFixEnabled',
  },
  {
    id: 'auto-approve',
    label: 'Auto-approve AI fixes',
    description: 'Skips the manual "Approve Fix" step for fix-with-agent and resolve-conflict flows. The worker itself always runs; this only controls whether it acts automatically.',
    configPath: 'autoApproveAIFixes',
  },
  {
    id: 'disk-headroom-cleanup',
    label: 'Disk-headroom cleanup',
    description: 'Automatically reclaims disk space when a machine gets critically full. The monitoring worker always runs; this only controls whether it is allowed to delete anything.',
    configPath: 'diskHeadroom.cleanupEnabled',
  },
] as const;

function splitConfigPath(path: WorkerToggleConfigPath): [string, string | undefined] {
  const [head, tail] = path.split('.', 2);
  return [head, tail];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Reads a toggle's current value from config; `undefined` means "unset" (worker uses its own default). */
export function readWorkerToggleValue(config: InvokerConfigRecord, spec: WorkerToggleSpec): boolean | undefined {
  const [head, tail] = splitConfigPath(spec.configPath);
  if (!tail) {
    const value = config[head];
    return typeof value === 'boolean' ? value : undefined;
  }
  const nested = asRecord(config[head]);
  const value = nested?.[tail];
  return typeof value === 'boolean' ? value : undefined;
}

/** Pure setter — returns a new config record with the toggle applied, does not write to disk. */
export function applyWorkerToggle(
  config: InvokerConfigRecord,
  spec: WorkerToggleSpec,
  enabled: boolean,
): InvokerConfigRecord {
  const [head, tail] = splitConfigPath(spec.configPath);
  if (!tail) {
    return { ...config, [head]: enabled };
  }
  const nested = asRecord(config[head]) ?? {};
  return { ...config, [head]: { ...nested, [tail]: enabled } };
}

export function findWorkerToggle(id: string): WorkerToggleSpec | undefined {
  return ONBOARDING_WORKER_TOGGLES.find((spec) => spec.id === id);
}
