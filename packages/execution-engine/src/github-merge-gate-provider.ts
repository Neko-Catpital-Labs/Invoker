import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeBranchForGithubCli } from './github-branch-ref.js';
import { killProcessGroup, SIGKILL_TIMEOUT_MS } from './process-utils.js';
import type {
  MergeGateProvider,
  MergeGateProviderResult,
  MergeGateApprovalStatus,
  MergeGatePrLifecycle,
  MergeGateFailedCheck,
} from './merge-gate-provider.js';
import { RESTART_TO_BRANCH_TRACE } from './exec-trace.js';
import { isGitRefLockRace, retryTransientGitHubCli } from './git-utils.js';

type ExistingPullRequest = { url: string; number: number };

const DEFAULT_GITHUB_CLI_TIMEOUT_MS = 60_000;
const GITHUB_CLI_TIMEOUT_ENV = 'INVOKER_GITHUB_CLI_TIMEOUT_MS';

function getGitHubCliTimeoutMs(): number {
  const raw = process.env[GITHUB_CLI_TIMEOUT_ENV]?.trim();
  if (!raw) return DEFAULT_GITHUB_CLI_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_GITHUB_CLI_TIMEOUT_MS;
  return parsed;
}

export class GitHubMergeGateProvider implements MergeGateProvider {
  readonly name = 'github';

  private static readonly TARGET_REPO_ENV = 'INVOKER_GITHUB_TARGET_REPO';

  async createReview(opts: {
    baseBranch: string;
    featureBranch: string;
    title: string;
    cwd: string;
    body?: string;
  }): Promise<MergeGateProviderResult> {
    const { baseBranch, featureBranch, title, cwd, body } = opts;
    console.log(
      `${RESTART_TO_BRANCH_TRACE} GitHubMergeGateProvider.createReview ` +
      `baseBranch=${baseBranch} featureBranch=${featureBranch} title=${title} cwd=${cwd} body=${body}`,
    );
    const ghBase = normalizeBranchForGithubCli(baseBranch);
    const ghHead = normalizeBranchForGithubCli(featureBranch);
    const targetRepo = await this.resolveTargetRepo(cwd);
    console.log(`[merge-gate] createReview: ghBase=${ghBase} apiHead=${ghHead} cwd=${cwd}`);

    await this.pushFeatureBranch(cwd, featureBranch);

    const existing = await this.findExistingOpenPullRequest(cwd, targetRepo, ghHead);
    console.log(`${RESTART_TO_BRANCH_TRACE} GitHubMergeGateProvider.createReview existing=${existing}`);

    if (existing.length > 0) {
      const apiArgs = [
        'api', `repos/${targetRepo}/pulls/${existing[0].number}`,
        '--method', 'PATCH',
        '-f', `base=${ghBase}`,
        '-f', `title=${title}`,
      ];
      if (body) apiArgs.push('-f', `body=${body}`);
      const ghResult = await retryTransientGitHubCli(() => this.exec('gh', apiArgs, cwd));
      console.log(`${RESTART_TO_BRANCH_TRACE} GitHubMergeGateProvider.createReview update existing gh_result=${ghResult}`);

      return { url: existing[0].url, identifier: String(existing[0].number) };
    }

    const createArgs = [
      'api', `repos/${targetRepo}/pulls`,
      '--method', 'POST', '-f', `base=${ghBase}`,
      '-f', `head=${ghHead}`, '-f', `title=${title}`,
      '-f', `body=${body ?? ''}`,
    ];
    const stdout = await this.exec('gh', createArgs, cwd);
    const pr = JSON.parse(stdout) as { html_url: string; number: number };

    console.log(`${RESTART_TO_BRANCH_TRACE} GitHubMergeGateProvider.createReview creating stdout=${stdout}`);
    return { url: pr.html_url, identifier: String(pr.number) };
  }

  async closeReview(opts: {
    identifier: string;
    cwd: string;
  }): Promise<void> {
    const { identifier, cwd } = opts;
    const targetRepo = await this.resolveTargetRepo(cwd);
    await retryTransientGitHubCli(() => this.exec('gh', [
      'api', `repos/${targetRepo}/pulls/${identifier}`,
      '--method', 'PATCH',
      '-f', 'state=closed',
    ], cwd));
  }

  async getReviewBody(opts: {
    identifier: string;
    cwd: string;
  }): Promise<string> {
    const { identifier, cwd } = opts;
    const targetRepo = await this.resolveTargetRepo(cwd);
    const stdout = await retryTransientGitHubCli(() => this.exec('gh', [
      'api', `repos/${targetRepo}/pulls/${identifier}`,
      '--jq', '.body',
    ], cwd));
    return stdout.trim();
  }

  async updateReviewBody(opts: {
    identifier: string;
    cwd: string;
    body: string;
  }): Promise<void> {
    const { identifier, cwd, body } = opts;
    const targetRepo = await this.resolveTargetRepo(cwd);
    const tempDir = mkdtempSync(join(tmpdir(), 'invoker-pr-body-'));
    const bodyPath = join(tempDir, 'body.md');
    try {
      writeFileSync(bodyPath, body, 'utf8');
      await retryTransientGitHubCli(() => this.exec('gh', [
        'pr', 'edit', identifier,
        '--repo', targetRepo,
        '--body-file', bodyPath,
      ], cwd));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  async checkApproval(opts: {
    identifier: string;
    cwd: string;
  }): Promise<MergeGateApprovalStatus> {
    const { identifier, cwd } = opts;
    const targetRepo = await this.resolveTargetRepo(cwd);

    const stdout = await retryTransientGitHubCli(() => this.exec('gh', [
      'pr', 'view', identifier,
      '--repo', targetRepo,
      '--json', 'state,reviewDecision,url,headRefOid,headRefName,mergeStateStatus,statusCheckRollup',
    ], cwd));

    const data = JSON.parse(stdout) as {
      state: string;
      reviewDecision: string | null;
      url: string;
      headRefOid?: string;
      headRefName?: string;
      mergeStateStatus?: string;
      statusCheckRollup?: unknown[];
    };

    const lifecycle: MergeGatePrLifecycle =
      data.state === 'MERGED' ? 'merged' : data.state === 'CLOSED' ? 'closed' : 'open';
    const rejected = data.reviewDecision === 'CHANGES_REQUESTED';

    let statusText: string;
    if (data.state === 'MERGED') {
      statusText = 'Merged';
    } else if (data.reviewDecision === 'APPROVED') {
      statusText = 'Approved, awaiting merge';
    } else if (data.reviewDecision === 'CHANGES_REQUESTED') {
      statusText = 'Changes requested';
    } else if (data.state === 'CLOSED') {
      statusText = 'Closed';
    } else {
      statusText = 'Awaiting review';
    }

    return {
      lifecycle,
      rejected,
      statusText,
      url: data.url,
      headSha: data.headRefOid,
      headRef: data.headRefName,
      mergeState: normalizeMergeState(data.mergeStateStatus),
      hasMergeConflict: data.mergeStateStatus === 'DIRTY',
      checks: summarizeStatusChecks(data.statusCheckRollup),
    };
  }

  private async resolveTargetRepo(cwd: string): Promise<string> {
    const explicitTarget = process.env[GitHubMergeGateProvider.TARGET_REPO_ENV]?.trim();
    if (explicitTarget) {
      if (/^[^/\s]+\/[^/\s]+$/.test(explicitTarget)) return explicitTarget;
      throw new Error(
        `Invalid ${GitHubMergeGateProvider.TARGET_REPO_ENV}="${explicitTarget}". ` +
        'Expected format "owner/repo".',
      );
    }

    try {
      const url = await this.exec('git', ['remote', 'get-url', 'origin'], cwd);
      const parsed = this.parseGitHubRepoNwo(url);
      if (parsed) return parsed;
    } catch {
      // fall through to error
    }
    throw new Error(
      'Unable to resolve GitHub target repo. ' +
      `Set ${GitHubMergeGateProvider.TARGET_REPO_ENV}=owner/repo or configure a parseable origin GitHub remote.`,
    );
  }

  private async pushFeatureBranch(cwd: string, featureBranch: string): Promise<void> {
    const pushArgs = ['push', '--force', 'origin', `${featureBranch}:refs/heads/${featureBranch}`];
    try {
      await this.exec('git', pushArgs, cwd);
    } catch (err) {
      if (!isGitRefLockRace(err)) throw err;
      await this.exec('git', [
        'fetch',
        'origin',
        `+refs/heads/${featureBranch}:refs/remotes/origin/${featureBranch}`,
      ], cwd);
      await this.exec('git', pushArgs, cwd);
    }
  }

  private async findExistingOpenPullRequest(
    cwd: string,
    targetRepo: string,
    ghHead: string,
  ): Promise<ExistingPullRequest[]> {
    try {
      const listOutput = await this.exec('gh', [
        'pr', 'list',
        '--repo', targetRepo,
        '--head', ghHead,
        '--state', 'open',
        '--json', 'url,number',
        '--limit', '1',
      ], cwd);
      console.log(`${RESTART_TO_BRANCH_TRACE} GitHubMergeGateProvider.createReview listOutput=${listOutput}`);
      return JSON.parse(listOutput) as ExistingPullRequest[];
    } catch (err) {
      console.warn(
        `[merge-gate] gh pr list failed; falling back to REST pulls lookup: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
      return this.findExistingOpenPullRequestViaRest(cwd, targetRepo, ghHead);
    }
  }

  private async findExistingOpenPullRequestViaRest(
    cwd: string,
    targetRepo: string,
    ghHead: string,
  ): Promise<ExistingPullRequest[]> {
    const owner = targetRepo.split('/')[0];
    if (!owner) throw new Error(`Invalid GitHub target repo "${targetRepo}". Expected format "owner/repo".`);
    const output = await retryTransientGitHubCli(() => this.exec('gh', [
      'api', `repos/${targetRepo}/pulls`,
      '--method', 'GET',
      '-f', 'state=open',
      '-f', `head=${owner}:${ghHead}`,
      '-f', 'per_page=1',
    ], cwd));
    console.log(`${RESTART_TO_BRANCH_TRACE} GitHubMergeGateProvider.createReview restListOutput=${output}`);
    const pulls = JSON.parse(output) as Array<{ html_url?: string; url?: string; number: number }>;
    return pulls
      .map((pull) => ({
        url: pull.html_url ?? pull.url ?? '',
        number: pull.number,
      }))
      .filter((pull): pull is ExistingPullRequest => Boolean(pull.url) && Number.isFinite(pull.number));
  }

  private parseGitHubRepoNwo(url: string): string | undefined {
    const m = url.trim().match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?\/?$/i);
    return m?.[1];
  }

  private async exec(cmd: string, args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: cmd === 'gh' && process.platform !== 'win32',
      });
      const timeoutMs = cmd === 'gh' ? getGitHubCliTimeoutMs() : 0;
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

      if (timeoutMs > 0) {
        timeout = setTimeout(() => {
          killProcessGroup(child, 'SIGTERM');
          const forceKill = setTimeout(() => {
            killProcessGroup(child, 'SIGKILL');
          }, SIGKILL_TIMEOUT_MS);
          forceKill.unref?.();
          finish(() => reject(new Error(
            `gh ${args.join(' ')} exceeded GitHub CLI timeout (${timeoutMs}ms) in ${cwd}. ` +
            `Set ${GITHUB_CLI_TIMEOUT_ENV} to adjust.`,
          )));
        }, timeoutMs);
        timeout.unref?.();
      }

      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('error', (err) => {
        finish(() => reject(err));
      });
      child.on('close', (code) => {
        finish(() => {
          if (code === 0) resolve(stdout.trim());
          else reject(new Error(`${cmd} ${args.join(' ')} failed (code ${code}): ${stderr.trim()}`));
        });
      });
    });
  }
}

function normalizeMergeState(value: string | undefined): 'clean' | 'dirty' | 'unknown' {
  switch (value) {
    case 'CLEAN':
    case 'HAS_HOOKS':
    case 'UNSTABLE':
      return 'clean';
    case 'DIRTY':
    case 'BLOCKED':
    case 'BEHIND':
      return 'dirty';
    default:
      return 'unknown';
  }
}

function stringProp(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return undefined;
}

function summarizeStatusChecks(items: unknown[] | undefined): MergeGateApprovalStatus['checks'] {
  if (!Array.isArray(items) || items.length === 0) return undefined;

  let hasPending = false;
  const failed: MergeGateFailedCheck[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const check = item as Record<string, unknown>;
    const name = stringProp(check, 'name', 'workflowName', 'context') ?? 'unknown check';
    const status = stringProp(check, 'status')?.toUpperCase();
    const conclusion = stringProp(check, 'conclusion')?.toUpperCase();
    const state = stringProp(check, 'state')?.toUpperCase();
    if (state) {
      if (state === 'PENDING' || state === 'EXPECTED') {
        hasPending = true;
        continue;
      }
      if (state !== 'SUCCESS') {
        failed.push({
          name,
          conclusion: state,
          detailsUrl: stringProp(check, 'detailsUrl', 'targetUrl'),
          summary: stringProp(check, 'summary', 'description'),
        });
      }
      continue;
    }
    if (status && status !== 'COMPLETED') {
      hasPending = true;
      continue;
    }
    if (conclusion && conclusion !== 'SUCCESS' && conclusion !== 'SKIPPED' && conclusion !== 'NEUTRAL') {
      failed.push({
        name,
        conclusion,
        detailsUrl: stringProp(check, 'detailsUrl', 'targetUrl'),
        summary: stringProp(check, 'summary', 'description'),
      });
    }
  }

  if (failed.length > 0) return { state: 'failure', failed };
  if (hasPending) return { state: 'pending', failed: [] };
  return { state: 'success', failed: [] };
}
