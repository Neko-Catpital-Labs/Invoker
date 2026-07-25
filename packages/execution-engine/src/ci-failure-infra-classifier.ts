import { spawn } from 'node:child_process';

import type { ReviewGateFailedCheck } from './lifecycle-events.js';

export type CiFailureClass = 'infra' | 'code' | 'unknown';

export interface ParsedActionsDetailsUrl {
  readonly runId: string;
  readonly jobId?: string;
}

const ACTIONS_DETAILS_URL_RE =
  /github\.com\/[^/]+\/[^/]+\/actions\/runs\/(\d+)(?:\/(?:attempts\/\d+\/)?jobs?\/(\d+))?/i;

/** Extract run/job ids from a GitHub Actions details URL. */
export function parseActionsDetailsUrl(detailsUrl: string | undefined): ParsedActionsDetailsUrl | null {
  if (!detailsUrl?.trim()) return null;
  const match = detailsUrl.match(ACTIONS_DETAILS_URL_RE);
  if (!match) return null;
  return {
    runId: match[1],
    ...(match[2] ? { jobId: match[2] } : {}),
  };
}

/**
 * True when failed-job log text matches self-hosted checkout / runner-hygiene
 * failures (e.g. PR #5188 packed-refs.lock / EACCES on workspace cleanup).
 */
export function isInfraCiFailureLog(logText: string): boolean {
  const text = logText.toLowerCase();
  if (!text.trim()) return false;

  const packedRefsPermission =
    text.includes('packed-refs.lock') && text.includes('permission denied');
  const eaccesCheckoutCleanup =
    text.includes('eacces')
    && text.includes('permission denied')
    && (
      text.includes('rmdir')
      || text.includes('.claude/plugins')
      || text.includes('actions/checkout')
      || text.includes('unable to prepare the existing repository')
    );
  const checkoutPermissionDenied =
    text.includes('actions/checkout')
    && text.includes('permission denied')
    && (
      text.includes('packed-refs')
      || text.includes('unable to prepare the existing repository')
      || text.includes('file was unable to be removed')
    );

  return packedRefsPermission || eaccesCheckoutCleanup || checkoutPermissionDenied;
}

export interface ClassifyFailedChecksResult {
  readonly classification: CiFailureClass;
  readonly matchedSignals: readonly string[];
  readonly classifiedCheckCount: number;
}

/**
 * Classify a set of failed checks from their fetched logs.
 * - infra: at least one log classified infra, and every fetched log is infra
 * - code: any fetched log is not infra
 * - unknown: no logs available / classifiable
 */
export function classifyFailedChecks(
  checks: readonly ReviewGateFailedCheck[],
  logsByDetailsUrl: ReadonlyMap<string, string>,
): ClassifyFailedChecksResult {
  const matchedSignals: string[] = [];
  let classifiedCheckCount = 0;
  let infraCount = 0;
  let codeCount = 0;

  for (const check of checks) {
    const url = check.detailsUrl?.trim();
    if (!url) continue;
    const log = logsByDetailsUrl.get(url);
    if (log === undefined) continue;
    classifiedCheckCount += 1;
    if (isInfraCiFailureLog(log)) {
      infraCount += 1;
      if (log.toLowerCase().includes('packed-refs.lock')) {
        matchedSignals.push('packed-refs.lock-permission-denied');
      }
      if (log.toLowerCase().includes('eacces')) {
        matchedSignals.push('eacces-permission-denied');
      }
      if (log.toLowerCase().includes('actions/checkout')) {
        matchedSignals.push('actions-checkout-permission-denied');
      }
    } else {
      codeCount += 1;
    }
  }

  if (classifiedCheckCount === 0) {
    return { classification: 'unknown', matchedSignals: [], classifiedCheckCount: 0 };
  }
  if (codeCount > 0) {
    return { classification: 'code', matchedSignals: unique(matchedSignals), classifiedCheckCount };
  }
  if (infraCount > 0) {
    return { classification: 'infra', matchedSignals: unique(matchedSignals), classifiedCheckCount };
  }
  return { classification: 'unknown', matchedSignals: [], classifiedCheckCount };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export type FailedCheckLogFetcher = (
  checks: readonly ReviewGateFailedCheck[],
) => Promise<Map<string, string>>;

export interface CreateFailedCheckLogFetcherOptions {
  cwd?: string;
  /** Override for tests; defaults to spawning `gh`. */
  runGh?: (args: readonly string[], cwd: string) => Promise<string>;
}

async function defaultRunGh(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', [...args], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`gh ${args.join(' ')} failed (code ${code}): ${stderr.trim()}`));
    });
  });
}

/** Build a fetcher that loads failed-step logs for Actions check details URLs. */
export function createFailedCheckLogFetcher(
  options: CreateFailedCheckLogFetcherOptions = {},
): FailedCheckLogFetcher {
  const cwd = options.cwd ?? process.cwd();
  const runGh = options.runGh ?? defaultRunGh;

  return async (checks) => {
    const out = new Map<string, string>();
    const seenRuns = new Map<string, string>();

    for (const check of checks) {
      const url = check.detailsUrl?.trim();
      if (!url || out.has(url)) continue;
      const parsed = parseActionsDetailsUrl(url);
      if (!parsed) continue;

      const cacheKey = parsed.jobId ? `job:${parsed.jobId}` : `run:${parsed.runId}`;
      const cached = seenRuns.get(cacheKey);
      if (cached !== undefined) {
        out.set(url, cached);
        continue;
      }

      try {
        const args = parsed.jobId
          ? ['run', 'view', '--log-failed', '--job', parsed.jobId]
          : ['run', 'view', parsed.runId, '--log-failed'];
        const log = await runGh(args, cwd);
        seenRuns.set(cacheKey, log);
        out.set(url, log);
      } catch {
        // Fail-open: missing logs leave the check unclassified.
      }
    }

    return out;
  };
}
