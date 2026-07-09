import type { Logger } from '@invoker/contracts';

import type { PrMaintenanceCommandResult, PrMaintenanceCommandRunner } from './pr-maintenance-command.js';

/** One CodeRabbit review comment, normalized from the inline + summary endpoints. */
export interface CoderabbitComment {
  body: string;
  updatedAt: string;
  path: string | null;
  htmlUrl: string | null;
}

/** Options for {@link createPrMaintenanceGitHub}. */
export interface PrMaintenanceGitHubOptions {
  /** Runs `gh` (and only `gh`) subcommands. */
  run: PrMaintenanceCommandRunner;
  /** `owner/repo` the jobs operate on. */
  repo: string;
  /** PR author filter for the open-PR listing. */
  author: string;
  logger: Logger;
  /** Delay between the first `gh` attempt and its single retry. */
  sleep: (ms: number) => Promise<void>;
}

/**
 * Typed GitHub surface for the PR-maintenance jobs, ported from `gh_json` and
 * the coderabbit-comment collectors. Every call runs `gh` with a single retry
 * on transient failure.
 */
export interface PrMaintenanceGitHub {
  /** `gh pr list` for open PRs by the configured author; returns parsed rows. */
  listOpenPullRequests(fields: string[]): Promise<Array<Record<string, unknown>>>;
  /** `gh pr view`; returns the parsed object, or `{}` on failure (parity with `|| {}`). */
  viewPullRequest(num: number, fields: string[]): Promise<Record<string, unknown>>;
  /** CodeRabbit inline + summary comments authored by `login`. Tolerant of endpoint failure. */
  fetchCoderabbitComments(num: number, login: string): Promise<CoderabbitComment[]>;
  /** `gh pr comment`; `true` only when the comment actually posted. */
  postPullRequestComment(num: number, body: string): Promise<boolean>;
}

/** Raised when a `gh` invocation fails after its retry. */
export class PrMaintenanceGhError extends Error {
  readonly result: PrMaintenanceCommandResult;

  constructor(message: string, result: PrMaintenanceCommandResult) {
    super(message);
    this.name = 'PrMaintenanceGhError';
    this.result = result;
  }
}

const GH_RETRY_DELAY_MS = 2000;

export function createPrMaintenanceGitHub(options: PrMaintenanceGitHubOptions): PrMaintenanceGitHub {
  const { run, repo, author, logger, sleep } = options;

  const ghJson = async (args: string[]): Promise<string> => {
    let result = await run({ command: 'gh', args });
    if (!isGhSuccess(result)) {
      await sleep(GH_RETRY_DELAY_MS);
      result = await run({ command: 'gh', args });
    }
    if (!isGhSuccess(result)) {
      const detail = result.stderr.trim() || result.stdout.trim() || result.spawnError?.message || 'unknown error';
      logger.warn(`[pr-maintenance] gh failed (gh ${args.join(' ')}): ${detail}`, {
        module: 'pr-maintenance-github',
      });
      throw new PrMaintenanceGhError(`gh ${args.join(' ')} failed`, result);
    }
    return result.stdout;
  };

  const fetchEndpoint = async (endpoint: string): Promise<Array<Record<string, unknown>>> => {
    try {
      return parseConcatenatedJsonArray(await ghJson(['api', endpoint, '--paginate']));
    } catch {
      // Parity with `gh api ... 2>/dev/null || true | jq -s 'add // []'`: a failed
      // endpoint contributes no comments rather than aborting the whole run.
      return [];
    }
  };

  return {
    async listOpenPullRequests(fields): Promise<Array<Record<string, unknown>>> {
      const out = await ghJson([
        'pr', 'list',
        '--repo', repo,
        '--author', author,
        '--state', 'open',
        '--json', fields.join(','),
        '--limit', '100',
      ]);
      const parsed = tryParseJson(out);
      return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
    },

    async viewPullRequest(num, fields): Promise<Record<string, unknown>> {
      try {
        const out = await ghJson(['pr', 'view', String(num), '--repo', repo, '--json', fields.join(',')]);
        const parsed = tryParseJson(out);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
      } catch {
        return {};
      }
    },

    async fetchCoderabbitComments(num, login): Promise<CoderabbitComment[]> {
      const inline = await fetchEndpoint(`repos/${repo}/pulls/${num}/comments`);
      const summary = await fetchEndpoint(`repos/${repo}/issues/${num}/comments`);
      const comments: CoderabbitComment[] = [];
      for (const raw of [...inline, ...summary]) {
        if (commentLogin(raw) !== login) continue;
        comments.push({
          body: asString(raw.body),
          updatedAt: asString(raw.updated_at),
          path: asStringOrNull(raw.path),
          htmlUrl: asStringOrNull(raw.html_url),
        });
      }
      return comments;
    },

    async postPullRequestComment(num, body): Promise<boolean> {
      const result = await run({
        command: 'gh',
        args: ['pr', 'comment', String(num), '--repo', repo, '--body', body],
      });
      if (isGhSuccess(result)) return true;
      // Single attempt then retry, matching gh_json, before reporting failure.
      const retry = await run({
        command: 'gh',
        args: ['pr', 'comment', String(num), '--repo', repo, '--body', body],
      });
      return isGhSuccess(retry);
    },
  };
}

function isGhSuccess(result: PrMaintenanceCommandResult): boolean {
  return result.spawnError === undefined && result.code === 0;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function commentLogin(raw: Record<string, unknown>): string | undefined {
  const user = raw.user;
  if (user && typeof user === 'object') {
    const login = (user as Record<string, unknown>).login;
    if (typeof login === 'string') return login;
  }
  return undefined;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Flatten `gh api --paginate` output for an array endpoint into one array of
 * objects. `--paginate` concatenates one JSON array per page with no separator,
 * so this scans top-level bracketed values (respecting strings/escapes) exactly
 * as the shell `jq -s 'add // []'` did.
 */
export function parseConcatenatedJsonArray(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        const parsed = tryParseJson(text.slice(start, i + 1));
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item && typeof item === 'object') out.push(item as Record<string, unknown>);
          }
        } else if (parsed && typeof parsed === 'object') {
          out.push(parsed as Record<string, unknown>);
        }
        start = -1;
      }
    }
  }
  return out;
}
