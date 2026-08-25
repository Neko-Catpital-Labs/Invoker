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

  it('documents always-on install-skills helpers and the local override', () => {
    const skill = readFileSync(join(repoRoot, 'skills', 'plan-to-invoker', 'SKILL.md'), 'utf8');

    expect(skill).toContain('always on via Cursor `~/.cursor/rules/invoker-execution-precedence.mdc`');
    expect(skill).toContain('a Codex AGENTS.md marked block');
    expect(skill).toContain('a Claude UserPromptSubmit hook');
    expect(skill).toContain(
      'One-slice same-repo edits stay local; multi-layer or multi-PR work goes through this',
    );
    expect(skill).toContain('unless the user says "do it locally"');
    expect(skill).toContain('`install-skills uninstall`. Trigger: "convert to invoker",');
    expect(skill).toContain(
      '"/invoker-plan-to-invoker", "/plan-to-invoker", or turning a plan file into',
    );
  });
});
