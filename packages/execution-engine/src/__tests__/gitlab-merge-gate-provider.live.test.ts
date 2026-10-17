import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDefaultReviewProviders } from '../create-default-review-providers.js';
import { resolveForgeProvider } from '../resolve-forge-provider.js';

const liveEnabled = process.env.INVOKER_GITLAB_LIVE === '1';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Invoker GitLab Live',
      GIT_AUTHOR_EMAIL: 'invoker-gitlab-live@example.invalid',
      GIT_COMMITTER_NAME: 'Invoker GitLab Live',
      GIT_COMMITTER_EMAIL: 'invoker-gitlab-live@example.invalid',
    },
  }).trim();
}

function glabApi(args: string[]): string {
  return execFileSync('glab', ['api', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  }).trim();
}

describe.runIf(liveEnabled)('GitLabMergeGateProvider live against gitlab.com', () => {
  let tempRoot = '';
  let repoDir = '';
  let projectPath = '';
  let projectId: number | undefined;
  let createdProject = false;
  let featureBranch = '';
  let baseBranch = 'main';
  let reviewId = '';
  let reviewUrl = '';

  beforeAll(() => {
    process.env.GIT_TERMINAL_PROMPT = '0';
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'credential.https://gitlab.com.helper';
    process.env.GIT_CONFIG_VALUE_0 = '!glab auth git-credential';

    execFileSync('glab', ['version'], { encoding: 'utf8' });
    const userJson = glabApi(['user']);
    const user = JSON.parse(userJson) as { username?: string };
    if (!user.username) {
      throw new Error('glab api user did not return a username; run `glab auth login` first');
    }

    const explicit = process.env.INVOKER_GITLAB_PROJECT?.trim();
    if (explicit) {
      projectPath = explicit.replace(/^\//, '').replace(/\/$/, '');
      const existing = JSON.parse(glabApi([`projects/${encodeURIComponent(projectPath)}`])) as { default_branch?: string };
      baseBranch = existing.default_branch?.trim() || baseBranch;
    } else {
      const stamp = Date.now();
      const name = `invoker-forge-live-${stamp}`;
      const created = JSON.parse(glabApi([
        '--method', 'POST',
        'projects',
        '-f', `name=${name}`,
        '-f', 'visibility=private',
        '-f', 'initialize_with_readme=true',
      ])) as { path_with_namespace?: string; id?: number; default_branch?: string };
      if (!created.path_with_namespace) {
        throw new Error(`failed to create GitLab project: ${JSON.stringify(created)}`);
      }
      projectPath = created.path_with_namespace;
      projectId = created.id;
      baseBranch = created.default_branch?.trim() || baseBranch;
      createdProject = true;
      process.env.INVOKER_GITLAB_PROJECT = projectPath;
    }

    tempRoot = mkdtempSync(join(tmpdir(), 'invoker-gitlab-forge-live-'));
    repoDir = join(tempRoot, 'repo');
    execFileSync('glab', ['repo', 'clone', projectPath, 'repo'], {
      cwd: tempRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    git(repoDir, ['checkout', '-B', baseBranch]);
    if (git(repoDir, ['rev-list', '--count', 'HEAD']) === '0') {
      writeFileSync(join(repoDir, 'README.md'), '# invoker forge live\n');
      git(repoDir, ['add', 'README.md']);
      git(repoDir, ['commit', '-m', 'seed']);
      git(repoDir, ['push', '-u', 'origin', baseBranch]);
    }

    featureBranch = `invoker-forge-live/${Date.now()}`;
    git(repoDir, ['checkout', '-b', featureBranch]);
    writeFileSync(join(repoDir, `forge-live-${Date.now()}.txt`), `live ${new Date().toISOString()}\n`);
    git(repoDir, ['add', '-A']);
    git(repoDir, ['commit', '-m', 'invoker gitlab forge live proof']);
  }, 180_000);

  afterAll(async () => {
    try {
      if (reviewId && repoDir) {
        const { mergeGateProvider } = createDefaultReviewProviders();
        const provider = resolveForgeProvider({
          reviewProviderRegistry: createDefaultReviewProviders().reviewProviderRegistry,
          mergeGateProvider,
          repoUrl: `https://gitlab.com/${projectPath}`,
        });
        await provider.closeReview?.({ identifier: reviewId, cwd: repoDir });
      }
    } catch (err) {
      console.warn(`[gitlab-live] failed to close MR ${reviewId} in ${projectPath}: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (createdProject && (projectId != null || projectPath)) {
      try {
        const target = projectId != null
          ? `projects/${projectId}`
          : `projects/${encodeURIComponent(projectPath)}`;
        glabApi(['--method', 'DELETE', target]);
      } catch (err) {
        console.warn(`[gitlab-live] failed to delete test project ${projectPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it('selects gitlab from the repo URL and creates/checks/updates/lists/closes an MR', async () => {
    const defaults = createDefaultReviewProviders();
    const provider = resolveForgeProvider({
      reviewProviderRegistry: defaults.reviewProviderRegistry,
      mergeGateProvider: defaults.mergeGateProvider,
      repoUrl: `https://gitlab.com/${projectPath}`,
    });
    expect(provider.name).toBe('gitlab');

    const created = await provider.createReview({
      baseBranch,
      featureBranch,
      title: `[invoker-live] GitLab forge proof ${Date.now()}`,
      cwd: repoDir,
      body: '## Summary\n\nLive GitLab forge proof from Invoker.\n',
    });
    reviewId = created.identifier;
    reviewUrl = created.url;

    expect(reviewId).toMatch(/^\d+$/);
    expect(reviewUrl).toContain('gitlab.com');
    expect(reviewUrl).toContain('/-/merge_requests/');

    const status = await provider.checkApproval({ identifier: reviewId, cwd: repoDir });
    expect(status.lifecycle).toBe('open');
    expect(status.url).toContain('/-/merge_requests/');

    const nextBody = `## Summary\n\nUpdated by live prove at ${new Date().toISOString()}\n`;
    await provider.updateReviewBody({ identifier: reviewId, cwd: repoDir, body: nextBody });
    const body = await provider.getReviewBody!({ identifier: reviewId, cwd: repoDir });
    expect(body).toContain('Updated by live prove');

    const open = await provider.listOpenReviews!({ projectPath, cwd: repoDir });
    expect(open.some((row) => String(row.number) === reviewId)).toBe(true);

    await provider.closeReview!({ identifier: reviewId, cwd: repoDir });
    const closed = await provider.checkApproval({ identifier: reviewId, cwd: repoDir });
    expect(closed.lifecycle).toBe('closed');
    reviewId = '';

    console.log(`INVOKER_GITLAB_LIVE_OK project=${projectPath} url=${reviewUrl}`);
  }, 300_000);
});
