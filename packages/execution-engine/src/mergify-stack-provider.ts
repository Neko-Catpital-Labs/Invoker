import { spawn } from 'node:child_process';
import { normalizeBranchForGithubCli } from './github-branch-ref.js';
import type { MergeGateProvider, MergeGateProviderResult, MergeGateApprovalStatus } from './merge-gate-provider.js';

/**
 * Publication strategy provider that uses `mergify stack push` to publish
 * branches as a Mergify-managed stack, then resolves the resulting GitHub
 * PR metadata via `gh pr list --head`.
 */
export class MergifyStackProvider implements MergeGateProvider {
  readonly name = 'mergify_stack';

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
      `[mergify-stack] createReview baseBranch=${baseBranch} ` +
      `featureBranch=${featureBranch} title=${title} cwd=${cwd}`,
    );

    // Ensure the feature branch is checked out in the gate workspace.
    await this.exec('git', ['checkout', featureBranch], cwd);

    // Push the stack via Mergify CLI.
    await this.execMergifyStackPush(cwd);

    // Resolve the PR that Mergify created for the feature branch.
    const ghHead = normalizeBranchForGithubCli(featureBranch);
    const targetRepo = await this.resolveTargetRepo(cwd);
    const { url, number } = await this.resolveStackPr(targetRepo, ghHead, cwd);

    // Update PR title and body to match the workflow metadata.
    const patchArgs = [
      'api', `repos/${targetRepo}/pulls/${number}`,
      '--method', 'PATCH', '-f', `title=${title}`,
    ];
    if (body) patchArgs.push('-f', `body=${body}`);
    await this.exec('gh', patchArgs, cwd);

    console.log(`[mergify-stack] Published stack PR: ${url} (#${number})`);
    return { url, identifier: String(number) };
  }

  async checkApproval(opts: {
    identifier: string;
    cwd: string;
  }): Promise<MergeGateApprovalStatus> {
    const { identifier, cwd } = opts;
    const targetRepo = await this.resolveTargetRepo(cwd);

    const stdout = await this.exec('gh', [
      'pr', 'view', identifier,
      '--repo', targetRepo,
      '--json', 'state,reviewDecision,url',
    ], cwd);

    const data = JSON.parse(stdout) as {
      state: string;
      reviewDecision: string | null;
      url: string;
    };

    const approved = data.reviewDecision === 'APPROVED' || data.state === 'MERGED';
    const rejected = data.state === 'CLOSED' || data.reviewDecision === 'CHANGES_REQUESTED';

    let statusText: string;
    if (data.state === 'MERGED') {
      statusText = 'Merged';
    } else if (data.reviewDecision === 'APPROVED') {
      statusText = 'Approved';
    } else if (data.reviewDecision === 'CHANGES_REQUESTED') {
      statusText = 'Changes requested';
    } else if (data.state === 'CLOSED') {
      statusText = 'Closed';
    } else {
      statusText = 'Awaiting review';
    }

    return { approved, rejected, statusText, url: data.url };
  }

  /**
   * Run `mergify stack push` in the given working directory.
   * Throws with a clear message when the Mergify CLI is not installed.
   */
  private async execMergifyStackPush(cwd: string): Promise<void> {
    try {
      await this.exec('mergify', ['stack', 'push'], cwd);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ENOENT') || msg.includes('not found')) {
        throw new Error(
          'Mergify CLI is not installed or not in PATH. ' +
          'Install it from https://docs.mergify.com/cli/ and ensure "mergify" is available.',
        );
      }
      throw new Error(`mergify stack push failed: ${msg}`);
    }
  }

  /**
   * Resolve the PR created by Mergify for the given head branch.
   * Retries once after a short delay to account for Mergify async PR creation.
   */
  private async resolveStackPr(
    targetRepo: string,
    head: string,
    cwd: string,
  ): Promise<{ url: string; number: number }> {
    const query = async (): Promise<{ url: string; number: number } | undefined> => {
      const listOutput = await this.exec('gh', [
        'pr', 'list',
        '--repo', targetRepo,
        '--head', head,
        '--state', 'open',
        '--json', 'url,number',
        '--limit', '1',
      ], cwd);
      const prs = JSON.parse(listOutput) as { url: string; number: number }[];
      return prs.length > 0 ? prs[0] : undefined;
    };

    // First attempt.
    const first = await query();
    if (first) return first;

    // Mergify may create the PR asynchronously — wait briefly and retry.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const second = await query();
    if (second) return second;

    throw new Error(
      `No open PR found for head "${head}" in ${targetRepo} after mergify stack push. ` +
      'Verify that Mergify created a PR for the pushed stack.',
    );
  }

  private async resolveTargetRepo(cwd: string): Promise<string> {
    const explicitTarget = process.env[MergifyStackProvider.TARGET_REPO_ENV]?.trim();
    if (explicitTarget) {
      if (/^[^/\s]+\/[^/\s]+$/.test(explicitTarget)) return explicitTarget;
      throw new Error(
        `Invalid ${MergifyStackProvider.TARGET_REPO_ENV}="${explicitTarget}". ` +
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
      `Set ${MergifyStackProvider.TARGET_REPO_ENV}=owner/repo or configure a parseable origin GitHub remote.`,
    );
  }

  private parseGitHubRepoNwo(url: string): string | undefined {
    const m = url.trim().match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?\/?$/i);
    return m?.[1];
  }

  private async exec(cmd: string, args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('error', (err) => reject(err));
      child.on('close', (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`${cmd} ${args.join(' ')} failed (code ${code}): ${stderr.trim()}`));
      });
    });
  }
}
