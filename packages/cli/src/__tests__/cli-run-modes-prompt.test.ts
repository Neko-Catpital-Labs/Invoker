import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { runCli, writeStandalonePlan } from './cli-test-helpers.js';

describe('invoker-cli run modes prompt', () => {
  it('standalone prompt-only plans route through the execution engine', () => {
    const dir = mkdtempSync(join(tmpdir(), 'invoker-cli-prompt-'));
    const planPath = writeStandalonePlan(dir, `name: Prompt-only standalone
repoUrl: __REPO_ROOT__
onFinish: none
tasks:
  - id: prompt
    description: Exercise prompt-only execution.
    prompt: Say hello.
    executionAgent: missing-agent
`);

    const result = runCli(['run', planPath, '--standalone', '--db-dir', join(dir, 'db'), '--json']);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('Standalone CLI v1 supports command tasks only');
    expect(`${result.stdout}\n${result.stderr}`).toContain('No execution agent registered with name "missing-agent"');
  }, 60_000);
});
