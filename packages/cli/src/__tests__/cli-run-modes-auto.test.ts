import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalBus } from '@invoker/transport';
import { describe, expect, it, vi } from 'vitest';

import { main } from '../index.js';
import { captureProcessOutput, fixturePlan, writeStandalonePlan } from './cli-test-helpers.js';

describe('invoker-cli run modes auto', () => {
  it('auto mode delegates when a GUI owner exists', async () => {
    const output = captureProcessOutput();
    const bus = new LocalBus();
    const runHandler = vi.fn(async () => ({ workflowId: 'wf-auto-live', tasks: [] }));
    const execHandler = vi.fn(async () => ({ ok: true }));
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'gui-1', mode: 'gui' }));
    bus.onRequest('headless.run', runHandler);
    bus.onRequest('headless.exec', execHandler);

    const code = await main(['run', fixturePlan], { createMessageBus: () => bus });

    expect(code).toBe(0);
    expect(runHandler).toHaveBeenCalledTimes(1);
    expect(execHandler).not.toHaveBeenCalled();
    expect(output.stdout).toContain('wf-auto-live');
    output.restore();
  });

  it('auto mode falls back to standalone when no GUI owner exists', async () => {
    const output = captureProcessOutput();
    const bus = new LocalBus();
    const dir = mkdtempSync(join(tmpdir(), 'invoker-cli-auto-'));
    const dbDir = join(dir, 'db');
    const planPath = writeStandalonePlan(dir, `name: Auto fallback in process
repoUrl: __REPO_ROOT__
onFinish: none
tasks:
  - id: hello
    description: Print hello from the standalone CLI.
    command: echo hello-from-invoker-cli
`);

    const code = await main(
      ['run', planPath, '--db-dir', dbDir],
      { createMessageBus: () => bus },
    );

    expect(code).toBe(0);
    output.restore();
  }, 60_000);
});
