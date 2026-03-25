import { spawn } from 'node:child_process';
import { normalizeBranchForGithubCli } from './github-branch-ref.js';
import type { MergeGateProvider, MergeGateProviderResult, MergeGateApprovalStatus } from './merge-gate-provider.js';

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
    const ghBase = normalizeBranchForGithubCli(baseBranch);
    const ghHead = normalizeBranchForGithubCli(featureBranch);

    // Push feature branch to origin
    await this.exec('git', ['push', '--force', '-u', 'origin', featureBranch], cwd);

    // Check for existing open PR on this branch
    const listOutput = await this.exec('gh', [
      'pr', 'list',
      '--head', ghHead,
      '--base', ghBase,
      '--state', 'open',
      '--json', 'url,number',
      '--limit', '1',
    ], cwd);

    const existing = JSON.parse(listOutput) as { url: string; number: number }[];

    if (existing.length > 0) {
      // Update title (and body if provided) of existing PR via REST API.
      // gh pr edit uses the deprecated projectCards GraphQL field which
      // causes exit-code 1 on gh CLI v2.45.0+.
      const apiArgs = [
        'api', `repos/{owner}/{repo}/pulls/${existing[0].number}`,
        '--method', 'PATCH', '-f', `title=${title}`,
      ];
      if (body) apiArgs.push('-f', `body=${body}`);
      await this.exec('gh', apiArgs, cwd);
      return { url: existing[0].url, identifier: String(existing[0].number) };
    }

    // No existing PR — create a new one via REST API.
    // gh pr create may also trigger the deprecated projectCards query.
    const createArgs = [
      'api', 'repos/{owner}/{repo}/pulls',
      '--method', 'POST', '-f', `base=${ghBase}`,
      '-f', `head=${ghHead}`, '-f', `title=${title}`,
      '-f', `body=${body ?? ''}`,
    ];
    const stdout = await this.exec('gh', createArgs, cwd);
    const pr = JSON.parse(stdout) as { html_url: string; number: number };

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

  private exec(cmd: string, args: string[], cwd: string): Promise<string> {
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
        else reject(new Error(`${cmd} ${args.join(' ')} failed (code ${code}): ${stderr.trim()}`));
      });
    });
  }
}
