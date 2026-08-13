import { describe, expect, it } from 'vitest';
import { extractRepoUrlFromText, isAllowedRepoUrl, normalizeAllowedRepoHosts, resolveChannelRepoUrl } from '../workers/slack-bug-scan-repo-url.js';

describe('slack-bug-scan repo url extraction', () => {
  const allowedHosts = ['github.com'];

  it('normalizes configured allowed hosts', () => {
    expect(normalizeAllowedRepoHosts([' GitHub.com ', 'github.com', '', 'gitlab.com']))
      .toEqual(['github.com', 'gitlab.com']);
  });

  it('rejects an ssh-style git url', () => {
    expect(extractRepoUrlFromText('repo: git@github.com:acme/widgets.git', allowedHosts)).toBeUndefined();
  });

  it('extracts an allowed https-style git url', () => {
    expect(extractRepoUrlFromText('see https://github.com/acme/widgets for source', allowedHosts)).toBe('https://github.com/acme/widgets');
  });

  it('rejects plaintext http repo urls', () => {
    expect(extractRepoUrlFromText('see http://github.com/acme/widgets for source', allowedHosts)).toBeUndefined();
    expect(isAllowedRepoUrl('http://github.com/acme/widgets', allowedHosts)).toBe(false);
  });

  it('rejects repo urls from untrusted hosts', () => {
    expect(extractRepoUrlFromText('see https://evil.example/acme/widgets for source', allowedHosts)).toBeUndefined();
    expect(isAllowedRepoUrl('https://evil.example/acme/widgets', allowedHosts)).toBe(false);
  });

  it('returns undefined when no url is present', () => {
    expect(extractRepoUrlFromText('just a random channel about snacks', allowedHosts)).toBeUndefined();
    expect(extractRepoUrlFromText(undefined, allowedHosts)).toBeUndefined();
  });

  it('picks the first allowed https match when multiple urls are present', () => {
    expect(extractRepoUrlFromText('https://evil.example/acme/one.git and https://github.com/acme/two.git', allowedHosts))
      .toBe('https://github.com/acme/two.git');
  });

  it('resolveChannelRepoUrl prefers topic over purpose', () => {
    expect(resolveChannelRepoUrl('https://github.com/acme/topic-repo.git', 'https://github.com/acme/purpose-repo', allowedHosts))
      .toBe('https://github.com/acme/topic-repo.git');
  });

  it('resolveChannelRepoUrl falls back to purpose when topic has no url', () => {
    expect(resolveChannelRepoUrl('no url here', 'https://github.com/acme/purpose-repo', allowedHosts))
      .toBe('https://github.com/acme/purpose-repo');
  });

  it('resolveChannelRepoUrl falls back to purpose when topic has no allowed url', () => {
    expect(resolveChannelRepoUrl('repo: http://github.com/acme/topic-repo', 'https://github.com/acme/purpose-repo', allowedHosts))
      .toBe('https://github.com/acme/purpose-repo');
  });

  it('resolveChannelRepoUrl returns undefined when neither has a url', () => {
    expect(resolveChannelRepoUrl('no url', 'also no url', allowedHosts)).toBeUndefined();
  });
});
