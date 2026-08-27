import { dirname, join } from 'node:path';
import {
  resolveInvokerInstanceProfile,
  resolveRepoRoot,
  type InvokerConfigRecord,
  type InvokerInstanceProfile,
} from '@invoker/contracts';
import { SQLiteAdapter } from '@invoker/data-store';
import {
  AUTO_FIX_WORKER_KIND,
  E2E_AUTOFIX_WORKER_KIND,
  IDLE_TASK_CLEANUP_WORKER_KIND,
  PR_ADMIN_BYPASS_LAND_WORKER_KIND,
  PR_AUTO_LABEL_WORKER_KIND,
  PR_DUPLICATE_CLOSE_WORKER_KIND,
  PR_ORPHAN_REPAIR_WORKER_KIND,
  PR_STATUS_WORKER_KIND,
} from '@invoker/execution-engine';

/**
 * Policy toggles still write an InvokerConfig boolean. Start toggles write
 * SQLite `worker_desired_states` for one or more worker kinds — never a
 * config start flag. See onboarding-invariants.ts.
 */
export type WorkerToggleConfigPath =
  | 'autoApproveAIFixes'
  | 'diskHeadroom.cleanupEnabled';

export type WorkerToggleSpec =
  | {
      id: string;
      label: string;
      description: string;
      /** Writes SQLite desired state for these worker kinds. */
      workerKinds: readonly string[];
      configPath?: undefined;
      defaultEnabled?: boolean;
      /** When false, setup wizard skips this toggle; CLI `worker toggles` still lists it. */
      includeInOnboarding?: boolean;
    }
  | {
      id: string;
      label: string;
      description: string;
      /** Writes a policy boolean in config (not process on/off). */
      configPath: WorkerToggleConfigPath;
      workerKinds?: undefined;
      defaultEnabled?: boolean;
      includeInOnboarding?: boolean;
    };

/** PR-maintenance onboarding preset → the four babysitting worker kinds. */
export const PR_MAINTENANCE_TOGGLE_WORKER_KINDS = [
  PR_ADMIN_BYPASS_LAND_WORKER_KIND,
  PR_ORPHAN_REPAIR_WORKER_KIND,
  PR_DUPLICATE_CLOSE_WORKER_KIND,
  PR_AUTO_LABEL_WORKER_KIND,
] as const;

/**
 * All CLI-controllable worker toggles. Setup wizard uses
 * {@link ONBOARDING_WORKER_TOGGLES} (excludes always-on kinds that are noisy
 * to re-prompt).
 */
export const WORKER_TOGGLES: readonly WorkerToggleSpec[] = [
  {
    id: 'pr-status',
    label: 'PR status',
    description: 'Polls GitHub PR / merge-gate status for open tasks. On by default with the owner; turn off only if you want to stop that polling.',
    workerKinds: [PR_STATUS_WORKER_KIND],
    defaultEnabled: true,
    includeInOnboarding: false,
  },
  {
    id: 'autofix',
    label: 'Autofix',
    description: 'Owner autofix worker that opens repair workflows for failing CI / stuck tasks.',
    workerKinds: [AUTO_FIX_WORKER_KIND],
    includeInOnboarding: false,
  },
  {
    id: 'pr-maintenance',
    label: 'PR maintenance',
    description: 'Babysits open PRs: re-queues stuck merges, closes duplicates, repairs orphaned stack fragments.',
    workerKinds: PR_MAINTENANCE_TOGGLE_WORKER_KINDS,
  },
  {
    id: 'e2e-autofix',
    label: 'E2E auto-fix',
    description: 'Runs the extended test battery on a schedule and opens a fix PR when it finds a failing suite.',
    workerKinds: [E2E_AUTOFIX_WORKER_KIND],
  },
  {
    id: 'auto-approve',
    label: 'Auto-approve AI fixes',
    description: 'Skips the manual "Approve Fix" step for fix-with-agent and resolve-conflict flows, but only for GitHub PRs whose author is listed in config.json autoApproveAuthors (missing/empty means nobody). The worker itself always runs; this only controls whether it acts automatically.',
    configPath: 'autoApproveAIFixes',
  },
  {
    id: 'disk-headroom-cleanup',
    label: 'Disk-headroom cleanup',
    description: 'Automatically reclaims disk space when a machine gets critically full. The monitoring worker always runs; this only controls whether it is allowed to delete anything.',
    configPath: 'diskHeadroom.cleanupEnabled',
    defaultEnabled: true,
  },
  {
    id: 'idle-task-cleanup',
    label: 'Idle task cleanup',
    description: 'Reports stale failed/completed/review_ready admin-bypass-repair and e2e-repair tasks. Dry-run only for now — it logs what it would close, it does not close anything yet.',
    workerKinds: [IDLE_TASK_CLEANUP_WORKER_KIND],
  },
] as const;

export const ONBOARDING_WORKER_TOGGLES: readonly WorkerToggleSpec[] = WORKER_TOGGLES.filter(
  (spec) => spec.includeInOnboarding !== false,
);

function splitConfigPath(path: WorkerToggleConfigPath): [string, string | undefined] {
  const [head, tail] = path.split('.', 2);
  return [head, tail];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function isPolicyWorkerToggle(
  spec: WorkerToggleSpec,
): spec is Extract<WorkerToggleSpec, { configPath: WorkerToggleConfigPath }> {
  return typeof spec.configPath === 'string';
}

export function isDesiredStateWorkerToggle(
  spec: WorkerToggleSpec,
): spec is Extract<WorkerToggleSpec, { workerKinds: readonly string[] }> {
  return Array.isArray(spec.workerKinds) && spec.workerKinds.length > 0;
}

/** Reads a policy toggle from config; `undefined` means unset. */
export function readWorkerToggleValue(config: InvokerConfigRecord, spec: WorkerToggleSpec): boolean | undefined {
  if (!isPolicyWorkerToggle(spec)) {
    return undefined;
  }
  const [head, tail] = splitConfigPath(spec.configPath);
  if (!tail) {
    const value = config[head];
    return typeof value === 'boolean' ? value : undefined;
  }
  const nested = asRecord(config[head]);
  const value = nested?.[tail];
  return typeof value === 'boolean' ? value : undefined;
}

/** Pure setter for policy toggles — does not write to disk. */
export function applyWorkerToggle(
  config: InvokerConfigRecord,
  spec: WorkerToggleSpec,
  enabled: boolean,
): InvokerConfigRecord {
  if (!isPolicyWorkerToggle(spec)) {
    throw new Error(
      `worker toggle "${spec.id}" writes desired state, not config; use applyDesiredStateWorkerToggle`,
    );
  }
  const [head, tail] = splitConfigPath(spec.configPath);
  if (!tail) {
    return { ...config, [head]: enabled };
  }
  const nested = asRecord(config[head]) ?? {};
  return { ...config, [head]: { ...nested, [tail]: enabled } };
}

export function findWorkerToggle(id: string): WorkerToggleSpec | undefined {
  return WORKER_TOGGLES.find((spec) => spec.id === id);
}

export interface CliRuntimeProfileOptions {
  startDir?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

/**
 * An installed CLI has no `pnpm-workspace.yaml` above it, so it keeps the
 * production `~/.invoker` layout; a source checkout resolves one, so it gets
 * a disjoint per-checkout profile instead of silently sharing the production
 * database/settings/onboarding/worker-toggle locations with the packaged app.
 * Explicit env overrides (e.g. INVOKER_DB_DIR) still win either way, since
 * resolveInvokerInstanceProfile applies them ahead of the profile default.
 *
 * The CLI's own test suite always runs from this checkout, so auto-detecting
 * from the real module location would classify every test process as
 * source-development. Callers that don't pin a startDir themselves skip
 * auto-detection under the test runner, keeping the production-shaped
 * default those tests already isolate against via a temp HOME.
 */
export function resolveCliInstanceProfile(options: CliRuntimeProfileOptions = {}): InvokerInstanceProfile {
  const env = options.env ?? process.env;
  const autoDetecting = options.startDir === undefined;
  let sourceRoot: string | undefined;
  if (!autoDetecting || !env.VITEST) {
    try {
      sourceRoot = resolveRepoRoot(options.startDir ?? __dirname);
    } catch {
      sourceRoot = undefined;
    }
  }
  return resolveInvokerInstanceProfile({
    kind: sourceRoot ? 'source-development' : 'packaged',
    sourceRoot,
    env,
    homeDir: options.homeDir,
    platform: options.platform,
  });
}

export function resolveInvokerDbPath(): string {
  if (process.env.INVOKER_DB_DIR) {
    return join(process.env.INVOKER_DB_DIR, 'invoker.db');
  }
  const configPath = process.env.INVOKER_REPO_CONFIG_PATH;
  if (configPath) {
    return join(dirname(configPath), 'invoker.db');
  }
  return join(resolveCliInstanceProfile().homeRoot, 'invoker.db');
}

function resolveInvokerOutputDir(dbPath: string): string {
  return join(dirname(dbPath), 'outputs');
}

export type WorkerDesiredStateStore = {
  getWorkerDesiredState(workerKind: string): { desiredEnabled: boolean } | undefined;
  setWorkerDesiredState(workerKind: string, desiredEnabled: boolean): unknown;
  close?: () => void;
};

/** True when every mapped worker kind is desired-enabled. */
export function readDesiredStateWorkerToggleValue(
  store: Pick<WorkerDesiredStateStore, 'getWorkerDesiredState'>,
  spec: Extract<WorkerToggleSpec, { workerKinds: readonly string[] }>,
): boolean | undefined {
  let sawAny = false;
  let allEnabled = true;
  for (const workerKind of spec.workerKinds) {
    const row = store.getWorkerDesiredState(workerKind);
    if (!row) return undefined;
    sawAny = true;
    if (!row.desiredEnabled) allEnabled = false;
  }
  return sawAny ? allEnabled : undefined;
}

/** Writes desiredEnabled for every worker kind in a start-preset toggle. */
export function applyDesiredStateWorkerToggle(
  store: Pick<WorkerDesiredStateStore, 'setWorkerDesiredState'>,
  spec: Extract<WorkerToggleSpec, { workerKinds: readonly string[] }>,
  enabled: boolean,
): void {
  for (const workerKind of spec.workerKinds) {
    store.setWorkerDesiredState(workerKind, enabled);
  }
}

/** Open the owner DB for toggle read/write. Caller must close. */
export async function openWorkerDesiredStateStore(
  dbPath: string = resolveInvokerDbPath(),
): Promise<WorkerDesiredStateStore> {
  return SQLiteAdapter.create(dbPath, {
    outputDir: resolveInvokerOutputDir(dbPath),
    ownerCapability: true,
  });
}
