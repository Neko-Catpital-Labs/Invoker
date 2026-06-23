import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { runCli } from './cli-test-helpers.js';

describe('invoker-cli run fixture invalid', () => {
  it('invalid YAML exits non-zero with a validation error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'invoker-cli-invalid-'));
    const invalidPlan = join(dir, 'invalid.yaml');
    writeFileSync(invalidPlan, 'name: [broken\n', 'utf8');
    const result = runCli(['run', invalidPlan, '--standalone', '--db-dir', join(dir, 'db')]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Invalid YAML');
  });
});
