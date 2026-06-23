import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { fixturePlan, runCli } from './cli-test-helpers.js';

describe('invoker-cli run fixture json', () => {
  it('--json emits a successful workflow result object', () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'invoker-cli-json-db-'));
    const result = runCli(['run', fixturePlan, '--standalone', '--db-dir', dbDir, '--json']);
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split('\n');
    const json = JSON.parse(lines[lines.length - 1]);
    expect(json.workflow.status).toBe('success');
  }, 60_000);
});
