import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('headless auto-fix cutover', () => {
  it('does not keep hidden auto-fix wiring in normal headless command paths', () => {
    const sources = [
      '../headless.ts',
      '../execution/task-runner-wiring.ts',
    ].map((path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'));

    for (const source of sources) {
      expect(source).not.toContain('wireHeadlessAutoFix');
      expect(source).not.toContain('onReviewGateCiFailure');
    }
  });
});
