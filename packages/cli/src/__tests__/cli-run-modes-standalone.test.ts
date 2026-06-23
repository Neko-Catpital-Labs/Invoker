import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { main } from '../index.js';
import { captureProcessOutput, writeStandalonePlan } from './cli-test-helpers.js';

describe('invoker-cli run modes standalone', () => {
  it('--standalone never opens IPC and still runs hello-world', async () => {
    const output = captureProcessOutput();
    const dir = mkdtempSync(join(tmpdir(), 'invoker-cli-standalone-'));
    const dbDir = join(dir, 'db');
    const planPath = writeStandalonePlan(dir, `name: Standalone in process
repoUrl: __REPO_ROOT__
onFinish: none
tasks:
  - id: hello
    description: Print hello from the standalone CLI.
    command: echo hello-from-invoker-cli
`);
    const createMessageBus = vi.fn(() => {
      throw new Error('unexpected IPC');
    });

    const code = await main(
      ['run', planPath, '--standalone', '--db-dir', dbDir],
      { createMessageBus },
    );

    expect(code).toBe(0);
    expect(createMessageBus).not.toHaveBeenCalled();
    expect(output.stdout).toContain('hello-from-invoker-cli');
    output.restore();
  }, 60_000);
});
