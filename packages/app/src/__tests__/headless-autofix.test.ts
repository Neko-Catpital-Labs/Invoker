import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('headless auto-fix ownership', () => {
  it('does not wire hidden auto-fix subscriptions in normal headless commands', async () => {
    const source = await readFile(resolve(here, '../headless.ts'), 'utf8');

    expect(source).not.toContain('wireHeadlessAutoFix');
  });
});
