import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createThrashDetectorTick,
  type ThrashDetectedSignature,
} from '../workers/thrash-detector-worker.js';
import type { PrMaintenanceCommandRunner, PrMaintenanceCommandResult } from '../workers/pr-maintenance-command.js';

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child() { return this; },
};

const detectedSignature: ThrashDetectedSignature = {
  signatureId: 'review-gate-loop',
  windowId: '2026-10-01T00:00:00Z/PT1H',
  taskIds: ['wf-a/fix', 'wf-b/fix'],
  prIds: ['101', '102'],
  evidence: ['same review-gate failure repeated twice in the window'],
};

function commandResult(code: number): PrMaintenanceCommandResult {
  return {
    code,
    signal: null,
    stdout: '',
    stderr: code === 0 ? '' : 'submission failed',
    timedOut: false,
  };
}

async function tempLedgerPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'thrash-detector-worker-test-'));
  return join(dir, 'ledger.tsv');
}

describe('thrash detector worker signature submission', () => {
  it('submits exactly one plan when a signature crosses the threshold', async () => {
    const ledgerPath = await tempLedgerPath();
    const commandRunner = vi.fn<PrMaintenanceCommandRunner>(async () => commandResult(0));
    const auditEventLogger = vi.fn();
    const tick = createThrashDetectorTick({
      logger: silentLogger as any,
      repoRoot: process.cwd(),
      ledgerPath,
      detectSignatures: () => [detectedSignature],
      auditEventLogger,
      commandRunner,
    });

    await tick();

    expect(auditEventLogger).toHaveBeenCalledTimes(1);
    expect(auditEventLogger).toHaveBeenCalledWith('thrash.detected', detectedSignature);
    expect(commandRunner).toHaveBeenCalledTimes(1);
    expect(commandRunner.mock.calls[0]?.[0].args).toEqual([
      '--headless',
      'run',
      expect.stringMatching(/review-gate-loop.*pt1h\.yaml$/),
    ]);
  });

  it('does not resubmit for the same signature within the same window', async () => {
    const ledgerPath = await tempLedgerPath();
    const commandRunner = vi.fn<PrMaintenanceCommandRunner>(async () => commandResult(0));
    const tick = createThrashDetectorTick({
      logger: silentLogger as any,
      repoRoot: process.cwd(),
      ledgerPath,
      detectSignatures: () => [detectedSignature],
      commandRunner,
    });

    await tick();
    await tick();

    expect(commandRunner).toHaveBeenCalledTimes(1);
  });

  it('respects the attempt cap after repeated submission failures', async () => {
    const ledgerPath = await tempLedgerPath();
    const commandRunner = vi.fn<PrMaintenanceCommandRunner>(async () => commandResult(1));
    const tick = createThrashDetectorTick({
      logger: silentLogger as any,
      repoRoot: process.cwd(),
      ledgerPath,
      attemptCap: 2,
      detectSignatures: () => [detectedSignature],
      commandRunner,
    });

    await tick();
    await tick();
    await tick();
    await tick();

    expect(commandRunner).toHaveBeenCalledTimes(2);
  });
});
