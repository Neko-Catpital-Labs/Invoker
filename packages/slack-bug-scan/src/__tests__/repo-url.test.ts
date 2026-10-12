import { describe, expect, it } from 'vitest';
import { extractRepoUrlFromText, resolveChannelRepoUrl } from '../repo-url.js';

describe('slack-bug-scan repo url extraction', () => {
  it('extracts an ssh-style git url', () => {
    expect(extractRepoUrlFromText('repo: git@github.com:acme/widgets.git')).toBe('git@github.com:acme/widgets.git');
  });

  it('extracts an https-style git url', () => {
    expect(extractRepoUrlFromText('see https://github.com/acme/widgets for source')).toBe('https://github.com/acme/widgets');
  });

  it('extracts a GitLab nested-group project url', () => {
    expect(extractRepoUrlFromText('see https://gitlab.com/Group/Sub/Project for source'))
      .toBe('https://gitlab.com/Group/Sub/Project');
  });

  it('returns the repository root for a forge review url', () => {
    expect(extractRepoUrlFromText('pr: https://github.com/Acme/Widgets/pull/42'))
      .toBe('https://github.com/acme/widgets');
    expect(extractRepoUrlFromText('mr: https://gitlab.com/Group/Sub/Project/-/merge_requests/42'))
      .toBe('https://gitlab.com/Group/Sub/Project');
  });

  it('returns the repository root for a forge job url', () => {
    expect(extractRepoUrlFromText('job: https://github.com/Acme/Widgets/actions/runs/123/attempts/1/jobs/456'))
      .toBe('https://github.com/acme/widgets');
    expect(extractRepoUrlFromText('job: https://gitlab.com/Group/Sub/Project/-/jobs/456'))
      .toBe('https://gitlab.com/Group/Sub/Project');
  });

  it('returns the repository root for a GitHub issue url', () => {
    expect(extractRepoUrlFromText('issue: https://github.com/acme/widgets/issues/99'))
      .toBe('https://github.com/acme/widgets');
  });

  it('returns undefined when no url is present', () => {
    expect(extractRepoUrlFromText('just a random channel about snacks')).toBeUndefined();
    expect(extractRepoUrlFromText(undefined)).toBeUndefined();
  });

  it('picks the first match when multiple urls are present', () => {
    expect(extractRepoUrlFromText('git@github.com:acme/one.git and git@github.com:acme/two.git'))
      .toBe('git@github.com:acme/one.git');
  });

  it('resolveChannelRepoUrl prefers topic over purpose', () => {
    expect(resolveChannelRepoUrl('git@github.com:acme/topic-repo.git', 'https://github.com/acme/purpose-repo'))
      .toBe('git@github.com:acme/topic-repo.git');
  });

  it('resolveChannelRepoUrl falls back to purpose when topic has no url', () => {
    expect(resolveChannelRepoUrl('no url here', 'https://github.com/acme/purpose-repo'))
      .toBe('https://github.com/acme/purpose-repo');
  });

  it('resolveChannelRepoUrl returns undefined when neither has a url', () => {
    expect(resolveChannelRepoUrl('no url', 'also no url')).toBeUndefined();
  });
});
