import { describe, expect, it } from 'vitest';
import { extractRepoUrlFromText, resolveChannelRepoUrl } from '../workers/slack-bug-scan-repo-url.js';
import { resolveSlackBugScanAllowedRepoHosts } from '../workers/slack-bug-scan.js';

describe('slack-bug-scan repo url extraction', () => {
  const allowedHosts = ['github.com'];

  it('extracts an allowed https-style git url', () => {
    expect(extractRepoUrlFromText('see https://github.com/acme/widgets for source', allowedHosts))
      .toBe('https://github.com/acme/widgets');
  });

  it('rejects ssh-style git urls', () => {
    expect(extractRepoUrlFromText('repo: git@github.com:acme/widgets.git', allowedHosts)).toBeUndefined();
  });

  it('rejects plaintext http urls', () => {
    expect(extractRepoUrlFromText('repo: http://github.com/acme/widgets.git', allowedHosts)).toBeUndefined();
  });

  it('rejects https urls on hosts outside the allowlist', () => {
    expect(extractRepoUrlFromText('repo: https://evil.example/acme/widgets.git', allowedHosts)).toBeUndefined();
  });

  it('returns undefined when no url is present', () => {
    expect(extractRepoUrlFromText('just a random channel about snacks', allowedHosts)).toBeUndefined();
    expect(extractRepoUrlFromText(undefined, allowedHosts)).toBeUndefined();
  });

  it('picks the first allowed match when multiple urls are present', () => {
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

  it('resolveChannelRepoUrl falls back to purpose when topic has only an untrusted url', () => {
    expect(resolveChannelRepoUrl('https://evil.example/acme/topic-repo.git', 'https://github.com/acme/purpose-repo', allowedHosts))
      .toBe('https://github.com/acme/purpose-repo');
  });

  it('resolveChannelRepoUrl returns undefined when neither has a url', () => {
    expect(resolveChannelRepoUrl('no url', 'also no url', allowedHosts)).toBeUndefined();
  });

  it('reads allowed hosts from comma-separated worker configuration env', () => {
    expect(resolveSlackBugScanAllowedRepoHosts({
      INVOKER_SLACK_BUG_SCAN_ALLOWED_REPO_HOSTS: ' github.com, ghe.example ',
    })).toEqual(['github.com', 'ghe.example']);
  });
});
