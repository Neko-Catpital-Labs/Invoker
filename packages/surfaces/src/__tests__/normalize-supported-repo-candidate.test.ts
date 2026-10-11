import { describe, expect, it } from 'vitest';

import { normalizeSupportedRepoCandidate } from '../slack/mention-parsers.js';

describe('normalizeSupportedRepoCandidate', () => {
  it('accepts a GitHub owner/repo web root', () => {
    expect(normalizeSupportedRepoCandidate('https://github.com/acme/widgets')).toBe(
      'https://github.com/acme/widgets',
    );
  });

  it('accepts a GitLab nested-group project web root', () => {
    expect(normalizeSupportedRepoCandidate('https://gitlab.com/Group/Sub/Project')).toBe(
      'https://gitlab.com/Group/Sub/Project',
    );
  });

  it('rejects a GitHub pull request URL as a repo root', () => {
    expect(normalizeSupportedRepoCandidate('https://github.com/acme/widgets/pull/12')).toBeUndefined();
  });

  it('accepts a clone URL ending in .git on any host', () => {
    expect(normalizeSupportedRepoCandidate('https://git.example.com/team/app.git')).toBe(
      'https://git.example.com/team/app.git',
    );
  });
});
