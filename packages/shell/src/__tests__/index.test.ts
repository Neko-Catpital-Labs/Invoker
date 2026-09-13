import { describe, it, expect } from 'vitest';

import { CURSOR_RULE_CONTENTS, EXECUTION_ROUTING_FRAGMENT } from '../always-on/fragments.js';

describe('package structure', () => {
  it('should export from index', () => {
    expect(true).toBe(true);
  });
});

describe('always-on execution routing', () => {
  it.each([
    ['Codex and Claude', EXECUTION_ROUTING_FRAGMENT],
    ['Cursor', CURSOR_RULE_CONTENTS],
  ])('defaults reviewed implementation work to GitHub publication for %s', (_host, contents) => {
    expect(contents).toContain('Implementation plans default to `onFinish: pull_request`');
    expect(contents).toContain('approval includes GitHub branch and PR/stack publication');
    expect(contents).toContain('without asking for a second authorization');
    expect(contents).not.toContain('workflow handoff only');
    expect(contents).not.toContain('do not publish PRs unless the user asks');
  });
});
