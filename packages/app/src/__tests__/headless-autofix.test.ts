import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('headless auto-fix cutover', () => {
  it('does not wire hidden auto-fix subscriptions from headless command paths', () => {
    const source = readFileSync(new URL('../headless.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('wireHeadlessAutoFix');
    expect(source).not.toContain('autoFixOnFailure');
  });
});
