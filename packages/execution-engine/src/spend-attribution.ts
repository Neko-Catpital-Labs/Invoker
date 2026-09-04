import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { E2E_AUTOFIX_WORKER_KIND } from './workers/e2e-autofix-worker.js';
import { PR_ADMIN_BYPASS_LAND_WORKER_KIND } from './workers/pr-maintenance-workers.js';

const CWD_PATTERN = /experiment-(wf-\d+-\d+)-(.+)-g\d+\.t\d+\.a-/;

const E2E_REPAIR_MARKER = 'invoker-ci-regression-watch: first-bad-sha=';
const ADMIN_BYPASS_REPAIR_NAME_PATTERN = /^repair-pr-\d+-.+$/;

function isAdminBypassRepairTask(workflowName: string | undefined): boolean {
  return typeof workflowName === 'string' && ADMIN_BYPASS_REPAIR_NAME_PATTERN.test(workflowName);
}

function isE2eRepairWorkflow(workflowDescription: string | undefined): boolean {
  return typeof workflowDescription === 'string' && workflowDescription.includes(E2E_REPAIR_MARKER);
}

export interface CodexSessionSummary {
  readonly sessionFile: string;
  readonly workflowId: string | undefined;
  readonly totalTokens: number | undefined;
  readonly startedAtMs: number | undefined;
}

function extractStartedAtMs(entry: unknown): number | undefined {
  const ts = (entry as { timestamp?: unknown } | null)?.timestamp;
  if (typeof ts !== 'string') return undefined;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : undefined;
}

export function summarizeCodexSessionFile(path: string): CodexSessionSummary {
  let workflowId: string | undefined;
  let totalTokens: number | undefined;
  let startedAtMs: number | undefined;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { sessionFile: path, workflowId: undefined, totalTokens: undefined, startedAtMs: undefined };
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (startedAtMs === undefined) {
      startedAtMs = extractStartedAtMs(entry);
    }
    if (entry.type === 'session_meta' && workflowId === undefined) {
      const cwd = (entry.payload as { cwd?: unknown } | undefined)?.cwd;
      if (typeof cwd === 'string') {
        const match = CWD_PATTERN.exec(cwd);
        if (match) workflowId = match[1];
      }
    }
    if (entry.type === 'event_msg') {
      const payload = entry.payload as { type?: unknown; info?: unknown } | undefined;
      if (payload?.type === 'token_count') {
        const info = (payload.info as { total_token_usage?: { total_tokens?: unknown } } | undefined)
          ?.total_token_usage;
        if (info && typeof info.total_tokens === 'number') {
          totalTokens = info.total_tokens;
        }
      }
    }
  }

  return { sessionFile: path, workflowId, totalTokens, startedAtMs };
}

export function listCodexSessionFiles(sessionRootDir: string): string[] {
  if (!existsSync(sessionRootDir)) return [];
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      if (name.startsWith('rollout-') && name.endsWith('.jsonl')) {
        found.push(full);
        continue;
      }
      if (depth >= 4) continue;
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        isDir = false;
      }
      if (isDir) walk(full, depth + 1);
    }
  };
  walk(sessionRootDir, 0);
  return found;
}

export interface WorkerSpendWindow {
  readonly windowStartMs: number;
  readonly nowMs: number;
  readonly tokensByWorkerKind: ReadonlyMap<string, number>;
}

export type WorkflowLookup = (workflowId: string) => { name?: string; description?: string } | undefined;

export function classifyWorkflowToWorkerKind(
  workflow: { name?: string; description?: string } | undefined,
): string | undefined {
  if (!workflow) return undefined;
  if (isAdminBypassRepairTask(workflow.name)) return PR_ADMIN_BYPASS_LAND_WORKER_KIND;
  if (isE2eRepairWorkflow(workflow.description)) return E2E_AUTOFIX_WORKER_KIND;
  return undefined;
}

export function summarizeWorkerSpend(
  sessionFiles: readonly string[],
  lookupWorkflow: WorkflowLookup,
  opts: { nowMs: number; windowMs: number },
): WorkerSpendWindow {
  const windowStartMs = opts.nowMs - opts.windowMs;
  const tokensByWorkerKind = new Map<string, number>();

  for (const file of sessionFiles) {
    const summary = summarizeCodexSessionFile(file);
    if (summary.startedAtMs === undefined || summary.startedAtMs < windowStartMs) continue;
    if (summary.workflowId === undefined || summary.totalTokens === undefined) continue;

    const workflow = lookupWorkflow(summary.workflowId);
    const workerKind = classifyWorkflowToWorkerKind(workflow);
    if (!workerKind) continue;

    tokensByWorkerKind.set(workerKind, (tokensByWorkerKind.get(workerKind) ?? 0) + summary.totalTokens);
  }

  return { windowStartMs, nowMs: opts.nowMs, tokensByWorkerKind };
}
