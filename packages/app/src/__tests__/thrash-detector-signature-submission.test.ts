import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  buildThrashSignatureFixPlanYaml,
  createThrashSignatureHeadlessRunCommand,
} from '../../../execution-engine/src/workers/thrash-detector-worker.js';

describe('thrash detector signature submission plan', () => {
  it('always generates a pull-request plan with external review', () => {
    const plan = parse(buildThrashSignatureFixPlanYaml({
      signatureId: 'signature/review-loop',
      windowId: '2026-10-01T00:00:00Z/PT1H',
      taskIds: ['wf-1/fix', 'wf-2/fix'],
      prIds: ['123', '124'],
      evidence: ['same failure signature crossed the configured threshold'],
    }));

    expect(plan.onFinish).toBe('pull_request');
    expect(plan.mergeMode).toBe('external_review');
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].prompt).toContain('signature/review-loop');
    expect(plan.tasks[0].prompt).toContain('wf-1/fix, wf-2/fix');
    expect(plan.tasks[0].prompt).toContain('123, 124');
    expect(plan.tasks[0].prompt).toContain('Do not merge, land, approve, or bypass review.');
  });

  it('runs only the headless plan submission command and no direct review mutation', () => {
    const command = createThrashSignatureHeadlessRunCommand({
      repoRoot: '/repo',
      planFile: '/tmp/thrash-plan.yaml',
    });

    expect(command.command).toBe('/repo/run.sh');
    expect(command.args).toEqual(['--headless', 'run', '/tmp/thrash-plan.yaml']);
    expect(`${command.command} ${command.args.join(' ')}`).not.toMatch(/\b(?:merge|approve|reject|land)\b/i);

    const sourcePath = fileURLToPath(new URL('../../../execution-engine/src/workers/thrash-detector-worker.ts', import.meta.url));
    const source = readFileSync(sourcePath, 'utf8');
    expect(source).not.toMatch(/\.submit\s*\([^)]*['"`][^'"`]*(?:merge|approve|reject|land)/i);
    expect(source).not.toMatch(/args:\s*\[[^\]]*['"`](?:merge|approve|reject|land)['"`]/i);
  });
});
