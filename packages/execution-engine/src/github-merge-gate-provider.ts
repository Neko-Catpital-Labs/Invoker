import { spawn } from 'node:child_process';
import { normalizeBranchForGithubCli } from './github-branch-ref.js';
import type { MergeGateProvider, MergeGateProviderResult, MergeGateApprovalStatus } from './merge-gate-provider.js';
import { RESTART_TO_BRANCH_TRACE } from './exec-trace.js';

export class GitHubMergeGateProvider implements MergeGateProvider {
  readonly name = 'github';

  async createReview(opts: {
    baseBranch: string;
    featureBranch: string;
    title: string;
    cwd: string;
    parentRemote?: string;
    body?: string;
  }): Promise<MergeGateProviderResult> {
    const { baseBranch, featureBranch, title, cwd, parentRemote, body } = opts;
    console.log(`${RESTART_TO_BRANCH_TRACE} GitHubMergeGateProvider.createReview baseBranch=${baseBranch} featureBranch=${featureBranch} title=${title} cwd=${cwd} parentRemote=${parentRemote ?? 'upstream'} body=${body}`);
    const parentRemoteName = parentRemote ?? 'upstream';
    const preparedBranch = await this.prepareReviewBranch(cwd, featureBranch, parentRemoteName);
    const ghBase = normalizeBranchForGithubCli(baseBranch);
    const ghHead = normalizeBranchForGithubCli(featureBranch);

    // In fork workflows (origin=fork, upstream=parent), the GitHub API needs
    // head qualified as "forkOwner:branch" for cross-repo PRs.
    const forkOwner = await this.detectForkOwner(cwd, parentRemoteName);
    const apiHead = forkOwner ? `${forkOwner}:${ghHead}` : ghHead;
    console.log(`[merge-gate] createReview: ghBase=${ghBase} apiHead=${apiHead} forkOwner=${forkOwner ?? 'none'} cwd=${cwd}`);

    try {
      // Push feature branch to origin
      if (preparedBranch.pushSource === featureBranch) {
        await this.exec('git', ['push', '--force', '-u', 'origin', featureBranch], cwd);
      } else {
        await this.exec('git', ['push', '--force', '-u', 'origin', `${preparedBranch.pushSource}:${featureBranch}`], cwd);
      }

      // Check for existing open PR on this branch
      const listOutput = await this.exec('gh', [
        'pr', 'list',
        '--head', apiHead,
        '--base', ghBase,
        '--state', 'open',
        '--json', 'url,number',
        '--limit', '1',
      ], cwd);
      console.log(`${RESTART_TO_BRANCH_TRACE} GitHubMergeGateProvider.createReview listOutput=${listOutput}`);

      const existing = JSON.parse(listOutput) as { url: string; number: number }[];
      console.log(`${RESTART_TO_BRANCH_TRACE} GitHubMergeGateProvider.createReview existing=${existing}`);

      if (existing.length > 0) {
        // Update title (and body if provided) of existing PR via REST API.
        // gh pr edit uses the deprecated projectCards GraphQL field which
        // causes exit-code 1 on gh CLI v2.45.0+.

        const apiArgs = [
          'api', `repos/{owner}/{repo}/pulls/${existing[0].number}`,
          '--method', 'PATCH', '-f', `title=${title}`,
        ];
        if (body) apiArgs.push('-f', `body=${body}`);
        const gh_result = await this.exec('gh', apiArgs, cwd);
        console.log(`${RESTART_TO_BRANCH_TRACE} GitHubMergeGateProvider.createReview update existing gh_result=${gh_result}`);

        return { url: existing[0].url, identifier: String(existing[0].number) };
      }

      // No existing PR — create a new one via REST API.
      // gh pr create may also trigger the deprecated projectCards query.
      const createArgs = [
        'api', 'repos/{owner}/{repo}/pulls',
        '--method', 'POST', '-f', `base=${ghBase}`,
        '-f', `head=${apiHead}`, '-f', `title=${title}`,
        '-f', `body=${body ?? ''}`,
      ];
      const stdout = await this.exec('gh', createArgs, cwd);
      const pr = JSON.parse(stdout) as { html_url: string; number: number };

      console.log(`${RESTART_TO_BRANCH_TRACE} GitHubMergeGateProvider.createReview creating stdout=${stdout}`);
      return { url: pr.html_url, identifier: String(pr.number) };
    } finally {
      await preparedBranch.cleanup();
    }
  }

  async checkApproval(opts: {
    identifier: string;
    cwd: string;
  }): Promise<MergeGateApprovalStatus> {
    const { identifier, cwd } = opts;

    const stdout = await this.exec('gh', [
      'pr', 'view', identifier,
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

    return {
      approved,
      rejected,
      statusText,
      url: data.url,
    };
  }

  /**
   * Detect fork workflow by checking if both origin and upstream remotes exist.
   * Returns the fork owner (from origin URL) so head can be qualified as "owner:branch".
   */
  private async detectForkOwner(cwd: string, parentRemote: string): Promise<string | undefined> {
    try {
      await this.exec('git', ['remote', 'get-url', parentRemote], cwd);
      const originUrl = await this.exec('git', ['remote', 'get-url', 'origin'], cwd);
      const match = originUrl.match(/github\.com[:/]([^/]+)\//);
      return match?.[1];
    } catch {
      return undefined;
    }
  }

  private async prepareReviewBranch(cwd: string, featureBranch: string, parentRemote: string): Promise<{
    pushSource: string;
    cleanup: () => Promise<void>;
  }> {
    if (!(await this.hasUpstreamRemote(cwd, parentRemote))) {
      return {
        pushSource: featureBranch,
        cleanup: async () => {},
      };
    }

    // The polluted-branch repair path only makes sense for real GitHub fork
    // workflows. Local/file origins used by dry-run and similar harnesses can
    // legitimately diverge from upstream without needing PR branch surgery.
    if (!(await this.detectForkOwner(cwd, parentRemote))) {
      return {
        pushSource: featureBranch,
        cleanup: async () => {},
      };
    }

    await this.exec('git', ['fetch', '--quiet', parentRemote, 'master'], cwd);
    await this.exec('git', ['fetch', '--quiet', 'origin', 'master'], cwd);

    const originOnly = new Set(await this.revList(`${parentRemote}/master..origin/master`, cwd));
    if (originOnly.size === 0) {
      return {
        pushSource: featureBranch,
        cleanup: async () => {},
      };
    }

    const headOnly = await this.revList(`${parentRemote}/master..${featureBranch}`, cwd);
    const polluted = headOnly.filter((sha) => originOnly.has(sha));
    if (polluted.length === 0) {
      return {
        pushSource: featureBranch,
        cleanup: async () => {},
      };
    }

    // Exclude merge commits: `git cherry-pick <merge-sha>` fails without -m,
    // and the non-merge commits brought in by those merges are already replayed
    // individually in this list. See commit message for full rationale.
    const intended = await this.revList(`origin/master..${featureBranch}`, cwd, {
      reverse: true,
      noMerges: true,
    });
    if (intended.length === 0) {
      throw new Error(
        `Feature branch "${featureBranch}" contains fork-only origin/master commits, but there are no feature commits in origin/master..${featureBranch} to auto-repair.`,
      );
    }

    const currentBranch = await this.exec('git', ['branch', '--show-current'], cwd);
    const originalHead = await this.exec('git', ['rev-parse', '--verify', 'HEAD'], cwd);
    const tempBranch = this.buildCleanBranchName(featureBranch);
    console.warn(`[merge-gate] auto-repairing polluted PR branch ${featureBranch} via ${tempBranch}`);

    try {
      await this.exec('git', ['switch', '-C', tempBranch, `${parentRemote}/master`], cwd);
      await this.cherryPickCommits(cwd, intended);
    } catch (error) {
      await this.clearCherryPickState(cwd);
      await this.restoreBranchState(cwd, currentBranch, originalHead);
      throw error;
    }

    return {
      pushSource: tempBranch,
      cleanup: async () => {
        await this.restoreBranchState(cwd, currentBranch, originalHead);
        await this.deleteBranchIfPresent(cwd, tempBranch);
      },
    };
  }

  private async hasUpstreamRemote(cwd: string, parentRemote: string): Promise<boolean> {
    try {
      await this.exec('git', ['remote', 'get-url', parentRemote], cwd);
      return true;
    } catch {
      return false;
    }
  }

  private async revList(
    range: string,
    cwd: string,
    opts?: { reverse?: boolean; noMerges?: boolean },
  ): Promise<string[]> {
    const args = ['rev-list'];
    if (opts?.reverse) args.push('--reverse');
    if (opts?.noMerges) args.push('--no-merges');
    args.push(range);
    const stdout = await this.exec('git', args, cwd);
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  private buildCleanBranchName(featureBranch: string): string {
    const safe = featureBranch.replace(/[^A-Za-z0-9._/-]+/g, '-').replace(/[\\/]+/g, '-');
    return `invoker/pr-clean/${safe}-${Date.now()}`;
  }

  private async restoreBranchState(cwd: string, currentBranch: string, originalHead: string): Promise<void> {
    if (currentBranch.trim() !== '') {
      await this.exec('git', ['switch', currentBranch], cwd);
      return;
    }
    await this.exec('git', ['switch', '--detach', originalHead], cwd);
  }

  private async cherryPickCommits(cwd: string, commits: string[]): Promise<void> {
    for (const commit of commits) {
      try {
        await this.exec('git', ['cherry-pick', commit], cwd);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          message.includes('previous cherry-pick is now empty')
          || message.includes('nothing to commit')
        ) {
          await this.exec('git', ['cherry-pick', '--skip'], cwd);
          continue;
        }
        throw error;
      }
    }
  }

  private async clearCherryPickState(cwd: string): Promise<void> {
    try {
      await this.exec('git', ['cherry-pick', '--quit'], cwd);
      return;
    } catch {
      // fall through
    }
    try {
      await this.exec('git', ['cherry-pick', '--abort'], cwd);
    } catch {
      // best effort only
    }
  }

  private async deleteBranchIfPresent(cwd: string, branch: string): Promise<void> {
    try {
      await this.exec('git', ['branch', '-D', branch], cwd);
    } catch {
      // Cleanup should not mask PR creation success.
    }
  }

  private exec(cmd: string, args: string[], cwd: string): Promise<string> {
    console.log(`[merge-gate] exec: ${cmd} ${args.join(' ')} (cwd=${cwd})`);
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('close', (code) => {
        if (code === 0) resolve(stdout.trim());
        else {
          console.error(`[merge-gate] exec FAILED (code ${code}): ${cmd} ${args.join(' ')} (cwd=${cwd})`);
          console.error(`[merge-gate] stdout: ${stdout}`);
          console.error(`[merge-gate] stderr: ${stderr}`);
          reject(new Error(`${cmd} ${args.join(' ')} failed (code ${code}): ${stderr.trim()}`));
        }
      });
    });
  }
}
