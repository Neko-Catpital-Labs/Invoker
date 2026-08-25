import type { TaskState } from '@invoker/workflow-core';

import type { PrMaintenanceCommandRunner } from './pr-maintenance-command.js';

export const AUTO_APPROVE_AUTHORS_CONFIG_KEY = 'autoApproveAuthors';

export type AutoApproveAllowlistRead =
  | { ok: true; authors: ReadonlySet<string> }
  | { ok: false; reason: 'missing' | 'empty' | 'unreadable' };

export type AutoApproveAuthorGateReason =
  | 'allowlist-missing'
  | 'allowlist-empty'
  | 'allowlist-unreadable'
  | 'no-mapped-pr'
  | 'pr-author-unresolved'
  | 'author-not-allowlisted';

export type AutoApproveAuthorGateResult =
  | { allowed: true; author: string; prNumber: string; repo: string }
  | { allowed: false; reason: AutoApproveAuthorGateReason };

export interface ParsedGithubPrRef {
  number: string;
  repo?: string;
}

/** Deduplicate GitHub logins case-insensitively, keeping first-seen spelling. */
export function normalizeAutoApproveAuthors(logins: readonly string[]): string[] {
  const seen = new Set<string>();
  const authors: string[] = [];
  for (const raw of logins) {
    const login = raw.trim();
    if (!login) continue;
    const key = login.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    authors.push(login);
  }
  return authors;
}

/** Read `autoApproveAuthors` from a config.json value. Missing/empty = nobody. */
export function authorsFromConfigValue(value: unknown): AutoApproveAllowlistRead {
  if (value === undefined) return { ok: false, reason: 'missing' };
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    return { ok: false, reason: 'unreadable' };
  }
  const authors = normalizeAutoApproveAuthors(value);
  if (authors.length === 0) return { ok: false, reason: 'empty' };
  return { ok: true, authors: new Set(authors.map((login) => login.toLowerCase())) };
}

export function isAllowlistedGithubLogin(
  login: string,
  authors: ReadonlySet<string>,
): boolean {
  const key = login.trim().toLowerCase();
  return key.length > 0 && authors.has(key);
}

export function parseGithubPrRef(
  reviewId?: string | null,
  reviewUrl?: string | null,
): ParsedGithubPrRef | null {
  const fromUrl = parsePrUrl(reviewUrl);
  if (fromUrl) return fromUrl;
  return parsePrId(reviewId);
}

function parsePrUrl(value?: string | null): ParsedGithubPrRef | null {
  if (!value) return null;
  const match = value.match(/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/i);
  if (!match) return null;
  return { repo: match[1], number: match[2] };
}

function parsePrId(value?: string | null): ParsedGithubPrRef | null {
  if (!value) return null;
  const fromUrl = parsePrUrl(value);
  if (fromUrl) return fromUrl;
  const bare = value.trim().replace(/^#/, '');
  return /^\d+$/.test(bare) ? { number: bare } : null;
}

/** Merge-node review id/url, including review-gate artifact fallbacks. */
export function mappedPrFromWorkflowTasks(
  tasks: readonly TaskState[],
): { reviewId?: string; reviewUrl?: string } | null {
  const merge = tasks.find((task) => task.config.isMergeNode === true);
  if (!merge) return null;
  const artifacts = merge.execution.reviewGate?.artifacts ?? [];
  const reviewId = firstNonEmpty(
    merge.execution.reviewId,
    artifacts.find((artifact) => typeof artifact.providerId === 'string')?.providerId,
  );
  const reviewUrl = firstNonEmpty(
    merge.execution.reviewUrl,
    artifacts.find((artifact) => typeof artifact.url === 'string')?.url,
  );
  if (!reviewId && !reviewUrl) return null;
  return { reviewId, reviewUrl };
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function evaluateAutoApproveAuthorGate(input: {
  allowlist: AutoApproveAllowlistRead;
  mappedPr: { reviewId?: string; reviewUrl?: string } | null;
  prAuthor: string | null;
  defaultRepo: string;
}): AutoApproveAuthorGateResult {
  if (!input.allowlist.ok) {
    return {
      allowed: false,
      reason: input.allowlist.reason === 'missing'
        ? 'allowlist-missing'
        : input.allowlist.reason === 'empty'
          ? 'allowlist-empty'
          : 'allowlist-unreadable',
    };
  }
  const parsed = parseGithubPrRef(input.mappedPr?.reviewId, input.mappedPr?.reviewUrl);
  if (!parsed) return { allowed: false, reason: 'no-mapped-pr' };
  const author = input.prAuthor?.trim() ?? '';
  if (!author) return { allowed: false, reason: 'pr-author-unresolved' };
  if (!isAllowlistedGithubLogin(author, input.allowlist.authors)) {
    return { allowed: false, reason: 'author-not-allowlisted' };
  }
  return {
    allowed: true,
    author,
    prNumber: parsed.number,
    repo: parsed.repo ?? input.defaultRepo,
  };
}

export function createGithubPrAuthorLookup(options: {
  run: PrMaintenanceCommandRunner;
  defaultRepo: string;
}): (ref: ParsedGithubPrRef) => Promise<string | null> {
  return async (ref) => {
    const repo = ref.repo?.trim() || options.defaultRepo;
    const result = await options.run({
      command: 'gh',
      args: ['pr', 'view', ref.number, '--repo', repo, '--json', 'author'],
    });
    if (result.spawnError || result.code !== 0) return null;
    try {
      const parsed: unknown = JSON.parse(result.stdout);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const author = (parsed as { author?: { login?: unknown } }).author?.login;
      return typeof author === 'string' && author.trim() ? author.trim() : null;
    } catch {
      return null;
    }
  };
}

export function createPersistedAutoApproveAuthorGate(options: {
  readAllowlist: () => AutoApproveAllowlistRead;
  loadTasks: (workflowId: string) => readonly TaskState[];
  loadTask?: (taskId: string) => TaskState | undefined;
  lookupPrAuthor: (ref: ParsedGithubPrRef) => Promise<string | null>;
  defaultRepo: string;
}): (taskId: string) => Promise<AutoApproveAuthorGateResult> {
  return async (taskId: string): Promise<AutoApproveAuthorGateResult> => {
    const allowlist = options.readAllowlist();
    const task = options.loadTask?.(taskId);
    const workflowId = task?.config.workflowId ?? taskId.split('/')[0];
    if (!workflowId) return { allowed: false, reason: 'no-mapped-pr' };
    const mappedPr = mappedPrFromWorkflowTasks(options.loadTasks(workflowId));
    const parsed = parseGithubPrRef(mappedPr?.reviewId, mappedPr?.reviewUrl);
    const prAuthor = parsed ? await options.lookupPrAuthor(parsed) : null;
    return evaluateAutoApproveAuthorGate({
      allowlist,
      mappedPr,
      prAuthor,
      defaultRepo: options.defaultRepo,
    });
  };
}
