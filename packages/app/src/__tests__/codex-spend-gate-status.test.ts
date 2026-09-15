import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordCodexSpendGateTrip } from '@invoker/execution-engine';

import { readCodexSpendGateStatus } from '../codex-spend-gate-status.js';

const dirs: string[] = [];

function gatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-spend-gate-status-'));
  dirs.push(dir);
  return join(dir, 'codex-spend-gate.json');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('readCodexSpendGateStatus', () => {
  it('reports a tripped gate with the reset command', () => {
    const path = gatePath();
    recordCodexSpendGateTrip(path, {
      trippedAt: '2026-09-13T16:35:24.179Z',
      dayKey: '2026-09-13',
      tokenBudget: 600_000_000,
      observedTokens: 610_323_524,
      tokensByHost: { owner: 559_935_118 },
    });

    const status = readCodexSpendGateStatus(path);

    expect(status.codexSpendGate).toMatchObject({ state: 'tripped', trippedAt: '2026-09-13T16:35:24.179Z', dayKey: '2026-09-13' });
    expect(status.codexSpendGate?.message).toContain('invoker-cli spend-gate reset');
  });

  it('reports nothing while the gate is open', () => {
    expect(readCodexSpendGateStatus(gatePath())).toEqual({});
  });

  it('reports an unreadable gate file instead of treating it as open', () => {
    const path = gatePath();
    writeFileSync(path, '{not json');

    const status = readCodexSpendGateStatus(path);

    expect(status.codexSpendGate).toMatchObject({ state: 'unreadable' });
    expect(status.codexSpendGate?.message).toContain('is not valid JSON');
  });
});
