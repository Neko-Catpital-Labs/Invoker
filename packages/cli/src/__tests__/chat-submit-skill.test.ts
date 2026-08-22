import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('chat-submit skill contract', () => {
  it('requires prepare → one approval → live submit → wait', () => {
    const skill = readFileSync(join(repoRoot, 'skills', 'chat-submit', 'SKILL.md'), 'utf8');

    expect(skill).toContain('invoker_prepare_plan_review');
    expect(skill).toContain('reviewToken');
    expect(skill).toContain('One approval before submit by default');
    expect(skill).toContain('invoker_submit_plan');
    expect(skill).toContain('mode: "live"');
    expect(skill).toContain('invoker_wait_for_workflow');
  });
});
