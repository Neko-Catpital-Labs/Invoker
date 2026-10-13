import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ForgeFetchFailedJobLogOptions,
  ForgeListOpenReviewsOptions,
  ForgeOpenReview,
  ForgeProvider,
  MergeGateApprovalStatus,
  MergeGateFailedCheck,
  MergeGatePrLifecycle,
  MergeGateProviderResult,
} from '@invoker/contracts';
import { parseForgeProject } from '@invoker/contracts';

import { normalizeBranchForGithubCli } from './github-branch-ref.js';
import { isGitRefLockRace } from './git-utils.js';
import { killProcessGroup, SIGKILL_TIMEOUT_MS } from './process-utils.js';

const DEFAULT_GITLAB_CLI_TIMEOUT_MS = 60_000;
const GITLAB_CLI_TIMEOUT_ENV = 'INVOKER_GITLAB_CLI_TIMEOUT_MS';

type ExistingMergeRequest = { url: string; iid: number };

function getGitLabCliTimeoutMs(): number {
  const raw = process.env[GITLAB_CLI_TIMEOUT_ENV]?.trim();
  if (!raw) return DEFAULT_GITLAB_CLI_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_GITLAB_CLI_TIMEOUT_MS;
  return parsed;
}

async function listRemoteNames(
  exec: (cmd: string, args: string[], cwd: string) => Promise<string>,
  cwd: string,
): Promise<string[]> {
  try {
    const output = await exec('git', ['remote'], cwd);
    const names = output
      .split('\n')
      .map((name) => name.trim())
      .filter(Boolean);
    return names.length > 0 ? names : ['origin'];
  } catch {
    return ['origin'];
  }
}

export class GitLabMergeGateProvider implements ForgeProvider {
  readonly name = 'gitlab' as const;

  private static readonly TARGET_PROJECT_ENV = 'INVOKER_GITLAB_PROJECT';

  async createReview(opts: {
    baseBranch: string;
    featureBranch: string;
    title: string;
    cwd: string;
    body?: string;
  }): Promise<MergeGateProviderResult> {
    const { baseBranch, featureBranch, title, cwd, body } = opts;
    const remoteNames = await listRemoteNames(this.exec.bind(this), cwd);
    const targetBranch = normalizeBranchForGithubCli(baseBranch, remoteNames);
    const sourceBranch = normalizeBranchForGithubCli(featureBranch, remoteNames);
    const project = await this.resolveTargetProject(cwd);

    await this.pushFeatureBranch(cwd, featureBranch);

    const existing = await this.findExistingOpenMergeRequest(cwd, project, sourceBranch);
    if (existing.length > 0) {
      const iid = existing[0].iid;
      await this.patchMergeRequest(cwd, project, iid, {
        target_branch: targetBranch,
        title,
        ...(body !== undefined ? { description: body } : {}),
      });
      return { url: existing[0].url, identifier: String(iid) };
    }

    const created = await this.createMergeRequest(cwd, project, {
      source_branch: sourceBranch,
      target_branch: targetBranch,
      title,
      description: body ?? '',
    });
    return { url: created.url, identifier: String(created.iid) };
  }

  async closeReview(opts: { identifier: string; cwd: string }): Promise<void> {
    const project = await this.resolveTargetProject(opts.cwd);
    await this.exec('glab', [
      'api',
      '--method', 'PUT',
      `projects/${encodeURIComponent(project)}/merge_requests/${opts.identifier}`,
      '-f', 'state_event=close',
    ], opts.cwd);
  }

  async getReviewBody(opts: { identifier: string; cwd: string }): Promise<string> {
    const project = await this.resolveTargetProject(opts.cwd);
    const stdout = await this.exec('glab', [
      'api',
      `projects/${encodeURIComponent(project)}/merge_requests/${opts.identifier}`,
    ], opts.cwd);
    const data = JSON.parse(stdout) as { description?: string | null };
    return (data.description ?? '').trim();
  }

  async updateReviewBody(opts: {
    identifier: string;
    cwd: string;
    body: string;
  }): Promise<void> {
    const project = await this.resolveTargetProject(opts.cwd);
    await this.patchMergeRequest(opts.cwd, project, Number(opts.identifier), {
      description: opts.body,
    });
  }

  async checkApproval(opts: {
    identifier: string;
    cwd: string;
  }): Promise<MergeGateApprovalStatus> {
    const project = await this.resolveTargetProject(opts.cwd);
    const stdout = await this.exec('glab', [
      'api',
      `projects/${encodeURIComponent(project)}/merge_requests/${opts.identifier}`,
    ], opts.cwd);
    const data = JSON.parse(stdout) as {
      state?: string;
      web_url?: string;
      sha?: string;
      source_branch?: string;
      detailed_merge_status?: string;
      has_conflicts?: boolean;
      merge_status?: string;
    };

    const approvalsStdout = await this.exec('glab', [
      'api',
      `projects/${encodeURIComponent(project)}/merge_requests/${opts.identifier}/approvals`,
    ], opts.cwd);
    const approvals = JSON.parse(approvalsStdout) as {
      approved?: boolean;
    };

    const lifecycle = resolveGitLabMergeRequestLifecycle(data.state);
    const approved = approvals.approved === true;
    const rejected = false;

    let statusText: string;
    if (lifecycle === 'merged') {
      statusText = 'Merged';
    } else if (lifecycle === 'closed') {
      statusText = 'Closed';
    } else if (approved) {
      statusText = 'Approved, awaiting merge';
    } else {
      statusText = 'Awaiting review';
    }

    const pipelineChecks = await this.fetchPipelineChecks(opts.cwd, project, opts.identifier);

    return {
      lifecycle,
      rejected,
      statusText,
      url: data.web_url ?? '',
      headSha: data.sha,
      headRef: data.source_branch,
      mergeState: data.has_conflicts
        ? 'dirty'
        : data.detailed_merge_status === 'mergeable' || data.merge_status === 'can_be_merged'
          ? 'clean'
          : 'unknown',
      hasMergeConflict: Boolean(data.has_conflicts),
      checks: pipelineChecks,
    };
  }

  async listOpenReviews(opts: ForgeListOpenReviewsOptions): Promise<ForgeOpenReview[]> {
    const stdout = await this.exec('glab', [
      'api',
      `projects/${encodeURIComponent(opts.projectPath)}/merge_requests?state=opened&per_page=100`,
    ], opts.cwd);
    const rows = JSON.parse(stdout) as Array<{
      iid: number;
      state?: string;
      target_branch?: string;
      source_branch?: string;
      sha?: string;
      web_url?: string;
    }>;
    return rows.map((row) => ({
      number: row.iid,
      state: row.state?.toLowerCase() === 'opened' ? 'OPEN' : (row.state ?? 'OPEN').toUpperCase(),
      baseRefName: row.target_branch ?? '',
      headRefName: row.source_branch ?? '',
      headRefOid: row.sha ?? '',
      url: row.web_url,
    }));
  }

  async fetchFailedJobLog(opts: ForgeFetchFailedJobLogOptions): Promise<string | undefined> {
    const project = parseForgeProject(opts.detailsUrl);
    if (!project || project.kind !== 'gitlab') return undefined;
    const jobId = project.jobId;
    if (!jobId) return undefined;
    try {
      return await this.exec('glab', [
        'ci', 'trace', jobId,
        '--repo', project.projectPath,
      ], opts.cwd);
    } catch {
      return undefined;
    }
  }

  private async fetchPipelineChecks(
    cwd: string,
    project: string,
    identifier: string,
  ): Promise<MergeGateApprovalStatus['checks']> {
    try {
      const stdout = await this.exec('glab', [
        'api',
        `projects/${encodeURIComponent(project)}/merge_requests/${identifier}/pipelines`,
      ], cwd);
      const pipelines = JSON.parse(stdout) as Array<{
        id?: number;
        status?: string;
        web_url?: string;
      }>;
      const latest = pipelines[0];
      if (!latest?.status) return undefined;
      const status = latest.status.toLowerCase();
      if (status === 'success' || status === 'skipped' || status === 'manual') {
        return { state: 'success', failed: [] };
      }
      if (status === 'pending' || status === 'running' || status === 'created' || status === 'waiting_for_resource') {
        return { state: 'pending', failed: [] };
      }
      if (status === 'failed' || status === 'canceled' || status === 'cancelled') {
        const failed: MergeGateFailedCheck[] = [{
          name: `pipeline-${latest.id ?? 'unknown'}`,
          conclusion: status,
          detailsUrl: latest.web_url,
        }];
        try {
          const jobsStdout = await this.exec('glab', [
            'api',
            `projects/${encodeURIComponent(project)}/pipelines/${latest.id}/jobs`,
          ], cwd);
          const jobs = JSON.parse(jobsStdout) as Array<{
            name?: string;
            status?: string;
            web_url?: string;
            id?: number;
          }>;
          const failedJobs = jobs.filter((job) => {
            const s = job.status?.toLowerCase();
            return s === 'failed' || s === 'canceled' || s === 'cancelled';
          });
          if (failedJobs.length > 0) {
            return {
              state: 'failure',
              failed: failedJobs.map((job) => ({
                name: job.name ?? `job-${job.id ?? 'unknown'}`,
                conclusion: job.status,
                detailsUrl: job.web_url,
              })),
            };
          }
        } catch {
        }
        return { state: 'failure', failed };
      }
      return { state: 'pending', failed: [] };
    } catch {
      return undefined;
    }
  }

  private async resolveTargetProject(cwd: string): Promise<string> {
    const explicit = process.env[GitLabMergeGateProvider.TARGET_PROJECT_ENV]?.trim();
    if (explicit) {
      if (explicit.includes('/')) return explicit.replace(/^\//, '').replace(/\/$/, '');
      throw new Error(
        `Invalid ${GitLabMergeGateProvider.TARGET_PROJECT_ENV}="${explicit}". ` +
        'Expected format "group/project" (nested groups allowed).',
      );
    }

    try {
      const url = await this.exec('git', ['remote', 'get-url', 'origin'], cwd);
      const parsed = parseForgeProject(url.trim());
      if (parsed?.kind === 'gitlab') return parsed.projectPath;
    } catch {
    }
    throw new Error(
      'Unable to resolve GitLab target project. ' +
      `Set ${GitLabMergeGateProvider.TARGET_PROJECT_ENV}=group/project or configure a parseable origin GitLab remote.`,
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
        '+refs/heads/*:refs/remotes/origin/*',
      ], cwd);
      await this.exec('git', pushArgs, cwd);
    }
  }

  private async findExistingOpenMergeRequest(
    cwd: string,
    project: string,
    sourceBranch: string,
  ): Promise<ExistingMergeRequest[]> {
    const stdout = await this.exec('glab', [
      'api',
      `projects/${encodeURIComponent(project)}/merge_requests?state=opened&source_branch=${encodeURIComponent(sourceBranch)}&per_page=1`,
    ], cwd);
    const rows = JSON.parse(stdout || '[]') as Array<{ web_url?: string; iid: number }>;
    return rows
      .filter((row) => Number.isFinite(row.iid) && row.web_url)
      .map((row) => ({ url: row.web_url!, iid: row.iid }));
  }

  private async createMergeRequest(
    cwd: string,
    project: string,
    fields: {
      source_branch: string;
      target_branch: string;
      title: string;
      description: string;
    },
  ): Promise<ExistingMergeRequest> {
    const tempDir = mkdtempSync(join(tmpdir(), 'invoker-glab-mr-'));
    const bodyPath = join(tempDir, 'create.json');
    try {
      writeFileSync(bodyPath, JSON.stringify(fields), 'utf8');
      const stdout = await this.exec('glab', [
        'api',
        '--method', 'POST',
        `projects/${encodeURIComponent(project)}/merge_requests`,
        '--input', bodyPath,
      ], cwd);
      const created = JSON.parse(stdout) as { web_url?: string; iid: number };
      if (!created.web_url || !Number.isFinite(created.iid)) {
        throw new Error(`glab create merge request returned unexpected payload`);
      }
      return { url: created.web_url, iid: created.iid };
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  private async patchMergeRequest(
    cwd: string,
    project: string,
    iid: number,
    fields: Record<string, string>,
  ): Promise<void> {
    const tempDir = mkdtempSync(join(tmpdir(), 'invoker-glab-mr-'));
    const bodyPath = join(tempDir, 'patch.json');
    try {
      writeFileSync(bodyPath, JSON.stringify(fields), 'utf8');
      await this.exec('glab', [
        'api',
        '--method', 'PUT',
        `projects/${encodeURIComponent(project)}/merge_requests/${iid}`,
        '--input', bodyPath,
      ], cwd);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  private async exec(cmd: string, args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: cmd === 'glab' && process.platform !== 'win32',
      });
      const timeoutMs = cmd === 'glab' ? getGitLabCliTimeoutMs() : 0;
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
            `glab ${args.join(' ')} exceeded GitLab CLI timeout (${timeoutMs}ms) in ${cwd}. ` +
            `Set ${GITLAB_CLI_TIMEOUT_ENV} to adjust.`,
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

export function resolveGitLabMergeRequestLifecycle(state: string | undefined): MergeGatePrLifecycle {
  const normalized = (state ?? '').toLowerCase();
  if (normalized === 'merged') return 'merged';
  if (normalized === 'closed') return 'closed';
  return 'open';
}
