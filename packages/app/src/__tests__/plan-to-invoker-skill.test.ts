import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';
const repoRoot = join(dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..');

describe('plan-to-invoker skill contract', () => {
  it('requires MCP review before host-side submission', () => {
    const skill = readFileSync(join(repoRoot, 'skills', 'plan-to-invoker', 'SKILL.md'), 'utf8');

    expect(skill).toContain('call `invoker_prepare_plan_review`');
    expect(skill).toContain('show its ordered steps plus `confirmationText`');
    expect(skill).toContain('call `invoker_submit_plan` only after approval unless the review result carries `confirmationMode: auto_submit`');
  });
});
