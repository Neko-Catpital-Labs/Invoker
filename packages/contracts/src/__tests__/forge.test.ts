import { afterEach, describe, expect, it } from 'vitest';

import {
  forgeProjectIdentity,
  parseForgeProject,
} from '../forge.js';

describe('parseForgeProject', () => {
  afterEach(() => {
    delete process.env.INVOKER_GITLAB_HOST;
  });

  it('parses a GitHub owner/repo web root case-insensitively', () => {
    expect(parseForgeProject('https://github.com/Acme/Widgets')).toEqual({
      kind: 'github',
      host: 'github.com',
      projectPath: 'acme/widgets',
    });
  });

  it('parses a GitHub pull request URL', () => {
    expect(parseForgeProject('https://github.com/acme/widgets/pull/12')).toEqual({
      kind: 'github',
      host: 'github.com',
      projectPath: 'acme/widgets',
      reviewId: '12',
    });
  });

  it('parses a GitHub Actions job URL', () => {
    expect(
      parseForgeProject('https://github.com/acme/widgets/actions/runs/99/job/55'),
    ).toEqual({
      kind: 'github',
      host: 'github.com',
      projectPath: 'acme/widgets',
      runId: '99',
      jobId: '55',
    });
  });

  it('parses GitHub ssh and https clone URLs', () => {
    expect(parseForgeProject('git@github.com:acme/widgets.git')).toEqual({
      kind: 'github',
      host: 'github.com',
      projectPath: 'acme/widgets',
    });
    expect(parseForgeProject('https://github.com/acme/widgets.git')).toEqual({
      kind: 'github',
      host: 'github.com',
      projectPath: 'acme/widgets',
    });
  });

  it('parses a GitLab nested-group project and preserves case', () => {
    expect(parseForgeProject('https://gitlab.com/Group/Sub/Project')).toEqual({
      kind: 'gitlab',
      host: 'gitlab.com',
      projectPath: 'Group/Sub/Project',
    });
  });

  it('parses a GitLab merge request URL', () => {
    expect(
      parseForgeProject('https://gitlab.com/Group/Sub/Project/-/merge_requests/7'),
    ).toEqual({
      kind: 'gitlab',
      host: 'gitlab.com',
      projectPath: 'Group/Sub/Project',
      reviewId: '7',
    });
  });

  it('parses GitLab job and pipeline URLs', () => {
    expect(
      parseForgeProject('https://gitlab.com/Group/Sub/Project/-/jobs/42'),
    ).toEqual({
      kind: 'gitlab',
      host: 'gitlab.com',
      projectPath: 'Group/Sub/Project',
      jobId: '42',
    });
    expect(
      parseForgeProject('https://gitlab.com/Group/Sub/Project/-/pipelines/9'),
    ).toEqual({
      kind: 'gitlab',
      host: 'gitlab.com',
      projectPath: 'Group/Sub/Project',
      pipelineId: '9',
    });
  });

  it('rejects unrecognized GitLab project subpaths', () => {
    expect(
      parseForgeProject('https://gitlab.com/Group/Sub/Project/-/issues/5'),
    ).toBeUndefined();
    expect(
      parseForgeProject('https://gitlab.com/Group/Sub/Project/-/tree/main'),
    ).toBeUndefined();
    expect(
      parseForgeProject('https://gitlab.com/Group/Sub/Project/-/blob/main/README.md'),
    ).toBeUndefined();
  });

  it('accepts INVOKER_GITLAB_HOST self-managed hosts', () => {
    process.env.INVOKER_GITLAB_HOST = 'git.example.com';
    expect(parseForgeProject('https://git.example.com/team/app/-/merge_requests/3')).toEqual({
      kind: 'gitlab',
      host: 'git.example.com',
      projectPath: 'team/app',
      reviewId: '3',
    });
  });

  it('matches self-managed GitLab SSH URLs with explicit ports by hostname', () => {
    process.env.INVOKER_GITLAB_HOST = 'git.example.com';
    expect(parseForgeProject('ssh://git@git.example.com:2222/team/app.git')).toEqual({
      kind: 'gitlab',
      host: 'git.example.com:2222',
      projectPath: 'team/app',
    });
  });

  it('rejects an unknown web host without a forge kind', () => {
    expect(parseForgeProject('https://bitbucket.org/acme/widgets')).toBeUndefined();
  });

  it('rejects a GitHub path that is not owner/repo', () => {
    expect(parseForgeProject('https://github.com/acme/widgets/issues/1')).toBeUndefined();
  });
});

describe('forgeProjectIdentity', () => {
  it('includes kind and host', () => {
    const project = parseForgeProject('https://github.com/Acme/Widgets');
    expect(project).toBeDefined();
    expect(forgeProjectIdentity(project!)).toBe('github:github.com/acme/widgets');
  });
});
