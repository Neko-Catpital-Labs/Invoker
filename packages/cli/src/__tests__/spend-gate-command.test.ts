import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CodexExecutionAgent, createCodexSpendGateReader } from '@invoker/execution-engine';

import { runSpendGateCommand } from '../spend-gate-command.js';

function newStatePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'spend-gate-cmd-')), 'codex-spend-gate.json');
}

function writeTrip(statePath: string): void {
  writeFileSync(
    statePath,
    JSON.stringify({
      trippedAt: '2026-09-04T04:11:00.000Z',
      dayKey: '2026-09-04',
      tokenBudget: 100_000_000,
      observedTokens: 1_471_200_000,
      tokensByHost: { owner: 894_900_000, remote_digital_ocean_3: 202_900_000 },
    }),
  );
}

describe('invoker-cli spend-gate', () => {
  it('reports an open gate and lets Codex run', () => {
    const statePath = newStatePath();
    let out = '';

    expect(runSpendGateCommand(['status'], { statePath, write: (t) => { out += t; } })).toBe(0);
    expect(out).toContain('open');

    const agent = new CodexExecutionAgent({ spendGate: createCodexSpendGateReader(statePath) });
    expect(agent.buildCommand('repair the failing CI job').cmd).toBe('codex');
  });

  it('reports a tripped gate with a non-zero exit and blocks every Codex request', () => {
    const statePath = newStatePath();
    writeTrip(statePath);
    let out = '';

    expect(runSpendGateCommand(['status'], { statePath, write: (t) => { out += t; } })).toBe(1);
    expect(out).toContain('every Codex request fails');
    expect(out).toContain('1471.2M tokens exceeds the 100.0M daily budget');
    expect(out).toContain('owner=894.9M');
    expect(out).toContain('invoker-cli spend-gate reset');

    const agent = new CodexExecutionAgent({ spendGate: createCodexSpendGateReader(statePath) });
    expect(() => agent.buildCommand('repair')).toThrow(/every Codex request fails/);
    expect(() => agent.buildResumeArgs('session-1')).toThrow(/every Codex request fails/);
    expect(() => agent.buildFixCommand('fix')).toThrow(/every Codex request fails/);
  });

  it('reopens the gate only on an explicit reset', () => {
    const statePath = newStatePath();
    writeTrip(statePath);
    let out = '';

    expect(runSpendGateCommand(['reset'], { statePath, write: (t) => { out += t; } })).toBe(0);
    expect(out).toContain('Cleared the Codex daily spend gate trip');
    expect(existsSync(statePath)).toBe(false);

    const agent = new CodexExecutionAgent({ spendGate: createCodexSpendGateReader(statePath) });
    expect(agent.buildCommand('repair').cmd).toBe('codex');
  });

  it('rejects an unknown subcommand instead of silently reopening the gate', () => {
    const statePath = newStatePath();
    writeTrip(statePath);

    expect(() => runSpendGateCommand(['clear'], { statePath, write: () => {} })).toThrow(
      /Usage: invoker-cli spend-gate/,
    );
    expect(existsSync(statePath)).toBe(true);
  });
});
