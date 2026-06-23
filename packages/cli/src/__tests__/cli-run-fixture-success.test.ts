import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { fixturePlan, runCli } from './cli-test-helpers.js';

describe('invoker-cli run fixture success', () => {
  it('runs the hello-world fixture with an isolated db dir', () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'invoker-cli-test-db-'));
    const result = runCli(['run', fixturePlan, '--standalone', '--db-dir', dbDir]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('hello-from-invoker-cli');
  }, 60_000);
});
