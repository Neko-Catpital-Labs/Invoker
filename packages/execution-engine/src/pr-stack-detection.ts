import { spawn } from 'node:child_process';

import { killProcessGroup, SIGKILL_TIMEOUT_MS } from './process-utils.js';
import { retryTransientGitHubCli } from './git-utils.js';

export const STACK_TRUNK_DEFAULT = 'master';
export const STACK_PREFIX_DEFAULT = 'stack/';

const DEFAULT_GITHUB_CLI_TIMEOUT_MS = 60_000;
const GITHUB_CLI_TIMEOUT_ENV = 'INVOKER_GITHUB_CLI_TIMEOUT_MS';

export interface StackPrRecord {
  readonly number: number;
  readonly state: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly headRefOid: string;
}

export interface PrStackDetectionResult {
  /** Deterministic id for this stack, stable across repeated detections of the
   *  same members (used as the dedup key for in-flight stack repairs). */
  readonly stackId: string;
  /** Bottom-to-top order: members[0] bases on trunk, each next member bases on
   *  the previous member's head branch. */
  readonly members: readonly StackPrRecord[];
}

export interface DetectStackOptions {
  readonly trunk?: string;
  readonly stackPrefix?: string;
}

/**
 * Walk the open-PR base/head branch chain to find every PR in the same
 * Mergify-managed stack as `failingPr`, ordered bottom-to-top. Ports the
 * linkage algorithm from scripts/land-stack.mjs's analyzeCompleteOpenStack
 * (base==prior-head chain, gated on a `stack/`-prefixed head branch) into TS,
 * so the CI repair worker can batch a whole stack in one PlanDefinition
 * instead of firing one repair plan per PR.
 *
 * Pure function, no I/O — a PR with no stack siblings (not on a `stack/`
 * branch, or no linked neighbors found) degenerates to a single-member
 * "stack of one", which is exactly today's single-PR repair behavior.
 */
export function detectStack(
  failingPr: StackPrRecord,
  allOpenPrs: readonly StackPrRecord[],
  options: DetectStackOptions = {},
): PrStackDetectionResult {
  const trunk = options.trunk ?? STACK_TRUNK_DEFAULT;
  const stackPrefix = options.stackPrefix ?? STACK_PREFIX_DEFAULT;

  if (!failingPr.headRefName.startsWith(stackPrefix)) {
    return { stackId: `single:${failingPr.number}`, members: [failingPr] };
  }

  const byNumber = new Map<number, StackPrRecord>();
  for (const pr of [...allOpenPrs, failingPr]) {
    if (pr.state === 'OPEN' && pr.headRefName.startsWith(stackPrefix)) {
      byNumber.set(pr.number, pr);
    }
  }
  const seed = byNumber.get(failingPr.number) ?? failingPr;
  const openStackPrs = [...byNumber.values()];
  const byHead = new Map(openStackPrs.map((pr) => [pr.headRefName, pr]));
  const childrenByBase = new Map<string, StackPrRecord[]>();
  for (const pr of openStackPrs) {
    const children = childrenByBase.get(pr.baseRefName) ?? [];
    children.push(pr);
    childrenByBase.set(pr.baseRefName, children);
  }

  const members: StackPrRecord[] = [seed];
  const seen = new Set<number>([seed.number]);

  // Walk down toward trunk. A missing parent (already merged, or genuinely not
  // open) or a cycle just stops the downward walk rather than erroring — the
  // known-open lower bound is still a valid partial stack to batch.
  let bottom = seed;
  while (bottom.baseRefName !== trunk) {
    const parent = byHead.get(bottom.baseRefName);
    if (!parent || seen.has(parent.number)) break;
    members.unshift(parent);
    seen.add(parent.number);
    bottom = parent;
  }

  // Walk up away from trunk. An ambiguous branch (more than one open PR based
  // on the same head) stops the upward walk rather than guessing an order.
  let top = members[members.length - 1];
  for (;;) {
    const children = (childrenByBase.get(top.headRefName) ?? []).filter((pr) => pr.number !== top.number);
    if (children.length !== 1) break;
    const child = children[0];
    if (seen.has(child.number)) break;
    members.push(child);
    seen.add(child.number);
    top = child;
  }

  const stackId = `stack:${trunk}:${members.map((pr) => pr.number).join(',')}`;
  return { stackId, members };
}

function getGitHubCliTimeoutMs(): number {
  const raw = process.env[GITHUB_CLI_TIMEOUT_ENV]?.trim();
  if (!raw) return DEFAULT_GITHUB_CLI_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GITHUB_CLI_TIMEOUT_MS;
}

/** Default `gh` exec: same spawn/timeout/process-group-kill shape used by
 *  GitHubMergeGateProvider, so stack detection behaves consistently with the
 *  rest of the review-gate GitHub CLI call sites. */
async function execGh(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const timeoutMs = getGitHubCliTimeoutMs();
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      fn();
    };

    timeout = setTimeout(() => {
      killProcessGroup(child, 'SIGTERM');
      const forceKill = setTimeout(() => killProcessGroup(child, 'SIGKILL'), SIGKILL_TIMEOUT_MS);
      forceKill.unref?.();
      finish(() => reject(new Error(`gh ${args.join(' ')} exceeded GitHub CLI timeout (${timeoutMs}ms) in ${cwd}.`)));
    }, timeoutMs);
    timeout.unref?.();

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (code) => finish(() => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${cmd} ${args.join(' ')} failed (code ${code}): ${stderr.trim()}`));
    }));
  });
}

export interface FetchOpenStackPrsOptions {
  readonly repo: string;
  readonly cwd: string;
  readonly exec?: (cmd: string, args: string[], cwd: string) => Promise<string>;
}

/** Live-fetch adapter: lists open PRs via `gh pr list` (same fields
 *  land-stack.mjs and github-merge-gate-provider.ts already consume) for
 *  detectStack to walk. Kept separate from detectStack so the linkage
 *  algorithm stays pure and unit-testable without any `gh` calls. */
export async function fetchOpenStackPrs(options: FetchOpenStackPrsOptions): Promise<StackPrRecord[]> {
  const exec = options.exec ?? execGh;
  const stdout = await retryTransientGitHubCli(() => exec('gh', [
    'pr', 'list',
    '--repo', options.repo,
    '--state', 'open',
    '--json', 'number,state,baseRefName,headRefName,headRefOid',
    '--limit', '500',
  ], options.cwd));
  const rows = JSON.parse(stdout) as StackPrRecord[];
  return rows.map((row) => ({
    number: row.number,
    state: row.state,
    baseRefName: row.baseRefName,
    headRefName: row.headRefName,
    headRefOid: row.headRefOid,
  }));
}
