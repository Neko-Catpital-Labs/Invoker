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
    body?: string;
  }): Promise<MergeGateProviderResult> {
    const { baseBranch, featureBranch, title, cwd, body } = opts;
    console.log(
      `${RESTART_TO_BRANCH_TRACE} GitHubMergeGateProvider.createReview ` +
      `baseBranch=${baseBranch} featureBranch=${featureBranch} title=${title} cwd=${cwd} body=${body}`,
    );
    const ghBase = normalizeBranchForGithubCli(baseBranch);
    const ghHead = normalizeBranchForGithubCli(featureBranch);
    console.log(`[merge-gate] createReview: ghBase=${ghBase} apiHead=${ghHead} cwd=${cwd}`);

    await this.exec('git', ['push', '--force', '-u', 'origin', featureBranch], cwd);

    const listOutput = await this.exec('gh', [
      'pr', 'list',
      '--head', ghHead,
      '--base', ghBase,
      '--state', 'open',
      '--json', 'url,number',
      '--limit', '1',
    ], cwd);
    console.log(`${RESTART_TO_BRANCH_TRACE} GitHubMergeGateProvider.createReview listOutput=${listOutput}`);

    const existing = JSON.parse(listOutput) as { url: string; number: number }[];
    console.log(`${RESTART_TO_BRANCH_TRACE} GitHubMergeGateProvider.createReview existing=${existing}`);

    if (existing.length > 0) {
      const apiArgs = [
        'api', `repos/{owner}/{repo}/pulls/${existing[0].number}`,
        '--method', 'PATCH', '-f', `title=${title}`,
      ];
      if (body) apiArgs.push('-f', `body=${body}`);
      const ghResult = await this.exec('gh', apiArgs, cwd);
      console.log(`${RESTART_TO_BRANCH_TRACE} GitHubMergeGateProvider.createReview update existing gh_result=${ghResult}`);

      return { url: existing[0].url, identifier: String(existing[0].number) };
    }

    const createArgs = [
      'api', 'repos/{owner}/{repo}/pulls',
      '--method', 'POST', '-f', `base=${ghBase}`,
      '-f', `head=${ghHead}`, '-f', `title=${title}`,
      '-f', `body=${body ?? ''}`,
    ];
    const stdout = await this.exec('gh', createArgs, cwd);
    const pr = JSON.parse(stdout) as { html_url: string; number: number };

    console.log(`${RESTART_TO_BRANCH_TRACE} GitHubMergeGateProvider.createReview creating stdout=${stdout}`);
    return { url: pr.html_url, identifier: String(pr.number) };
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

  private async exec(cmd: string, args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`${cmd} ${args.join(' ')} failed (code ${code}): ${stderr.trim()}`));
      });
    });
  }
}
