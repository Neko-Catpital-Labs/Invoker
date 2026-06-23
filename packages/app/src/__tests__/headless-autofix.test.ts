import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('headless auto-fix cutover', () => {
  it('does not keep hidden auto-fix wiring in normal headless command paths', () => {
    const source = readFileSync(fileURLToPath(new URL('../headless.ts', import.meta.url)), 'utf8');

    expect(source).not.toContain('wireHeadlessAutoFix');
  });
});
