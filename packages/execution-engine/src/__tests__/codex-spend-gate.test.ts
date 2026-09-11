import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '@invoker/contracts';

import {
  CodexSpendGateTrippedError,
  DEFAULT_CODEX_DAILY_TOKEN_BUDGET,
  clearCodexSpendGateTrip,
  codexSessionDayDir,
  createCodexSpendGateReader,
  evaluateCodexDailySpend,
  loadCodexSpendGateTrip,
  parseRemoteCodexTally,
  recordCodexSpendGateTrip,
  tallyCodexTokensForDay,
} from '../codex-spend-gate.js';
import { runCodexDailySpendGateTick } from '../workers/spend-circuit-breaker-worker.js';
import { CodexExecutionAgent } from '../agents/codex-execution-agent.js';
import { CodexPlanningAgent } from '../agents/codex-planning-agent.js';

const NOW_MS = Date.parse('2026-09-04T12:00:00.000Z');

function makeLogger() {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => logger),
  };
  return logger as unknown as Logger & typeof logger;
}

function writeRollout(sessionRoot: string, nowMs: number, name: string, totals: readonly number[]): void {
  const dayDir = codexSessionDayDir(sessionRoot, nowMs);
  mkdirSync(dayDir, { recursive: true });
  const lines = [
    JSON.stringify({ timestamp: new Date(nowMs).toISOString(), type: 'session_meta', payload: { cwd: '/tmp/x' } }),
    ...totals.map((total) => JSON.stringify({
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total } } },
    })),
  ];
  writeFileSync(join(dayDir, `rollout-${name}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
}

describe('tallyCodexTokensForDay', () => {
  it('sums the final cumulative token_count of every rollout log for that day', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-gate-tally-'));
    writeRollout(root, NOW_MS, 'a', [10, 250]);
    writeRollout(root, NOW_MS, 'b', [40]);
    writeRollout(root, NOW_MS - 24 * 60 * 60_000, 'yesterday', [999_999]);

    expect(tallyCodexTokensForDay(root, NOW_MS)).toBe(290);
  });
});

describe('evaluateCodexDailySpend', () => {
  it('does not trip at or below the budget', () => {
    const tokens = new Map([['owner', 60_000_000], ['do3', 40_000_000]]);
    expect(evaluateCodexDailySpend(tokens, DEFAULT_CODEX_DAILY_TOKEN_BUDGET)).toEqual({
      totalTokens: 100_000_000,
      tokenBudget: DEFAULT_CODEX_DAILY_TOKEN_BUDGET,
      exceeded: false,
    });
  });

  it('trips once the fleet total passes the budget', () => {
    const tokens = new Map([['owner', 60_000_000], ['do3', 40_000_001]]);
    expect(evaluateCodexDailySpend(tokens, DEFAULT_CODEX_DAILY_TOKEN_BUDGET).exceeded).toBe(true);
  });
});

describe('parseRemoteCodexTally', () => {
  it('reads the last numeric line', () => {
    expect(parseRemoteCodexTally('warning: something\n12345\n')).toBe(12345);
  });

  it('throws rather than silently reporting zero on unparseable output', () => {
    expect(() => parseRemoteCodexTally('ssh: connect refused')).toThrow(/unparseable/);
  });
});

describe('runCodexDailySpendGateTick', () => {
  function gateConfig(overrides: Record<string, unknown> = {}) {
    const stateDir = mkdtempSync(join(tmpdir(), 'codex-gate-state-'));
    return {
      statePath: join(stateDir, 'codex-spend-gate.json'),
      enabled: true,
      dailyTokenBudget: DEFAULT_CODEX_DAILY_TOKEN_BUDGET,
      localHostName: 'owner',
      localSessionRoot: '/does/not/matter',
      tallyLocal: () => 10_000_000,
      remoteTargets: [
        { name: 'do3', connection: { host: 'h3', user: 'invoker', sshKeyPath: '/k' } },
        { name: 'do5', connection: { host: 'h5', user: 'invoker', sshKeyPath: '/k' } },
      ],
      ...overrides,
    };
  }

  it('stays open and writes no trip file when the fleet total is under budget', async () => {
    const config = gateConfig({ tallyRemote: async () => 20_000_000 });
    const result = await runCodexDailySpendGateTick(config, makeLogger(), NOW_MS);

    expect(result.totalTokens).toBe(50_000_000);
    expect(result.tripped).toBe(false);
    expect(existsSync(config.statePath)).toBe(false);
  });

  it('trips and records every host once the fleet total exceeds 100M', async () => {
    const config = gateConfig({ tallyRemote: async () => 50_000_000 });
    const logger = makeLogger();

    const result = await runCodexDailySpendGateTick(config, logger, NOW_MS);

    expect(result.totalTokens).toBe(110_000_000);
    expect(result.tripped).toBe(true);
    const trip = loadCodexSpendGateTrip(config.statePath);
    expect(trip?.observedTokens).toBe(110_000_000);
    expect(trip?.dayKey).toBe('2026-09-04');
    expect(trip?.tokensByHost).toEqual({ owner: 10_000_000, do3: 50_000_000, do5: 50_000_000 });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('TRIPPED'), expect.anything());
  });

  it('surfaces a failing host instead of counting it as zero spend', async () => {
    const config = gateConfig({
      tallyRemote: async (target: { name: string }) => {
        if (target.name === 'do5') throw new Error('ssh timeout');
        return 20_000_000;
      },
    });
    const logger = makeLogger();

    const result = await runCodexDailySpendGateTick(config, logger, NOW_MS);

    expect(result.failedHosts).toEqual([{ host: 'do5', reason: 'ssh timeout' }]);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('remote tally failed on do5'), expect.anything());
  });

  it('does not re-evaluate or auto-clear while a trip is already recorded', async () => {
    const config = gateConfig({ tallyRemote: async () => 0 });
    recordCodexSpendGateTrip(config.statePath, {
      trippedAt: new Date(NOW_MS).toISOString(),
      dayKey: '2026-09-04',
      tokenBudget: DEFAULT_CODEX_DAILY_TOKEN_BUDGET,
      observedTokens: 900_000_000,
      tokensByHost: { owner: 900_000_000 },
    });

    const result = await runCodexDailySpendGateTick(config, makeLogger(), NOW_MS + 48 * 60 * 60_000);

    expect(result.alreadyTripped).toBe(true);
    expect(result.evaluated).toBe(false);
    expect(loadCodexSpendGateTrip(config.statePath)?.observedTokens).toBe(900_000_000);
  });

  it('counts a host once when the owner is also a configured remote target', async () => {
    const config = gateConfig({
      localHostName: 'remote_digital_ocean_1',
      tallyLocal: () => 20_406_837,
      remoteTargets: [
        { name: 'remote_digital_ocean_1', connection: { host: 'h1', user: 'invoker', sshKeyPath: '/k' } },
        { name: 'remote_digital_ocean_3', connection: { host: 'h3', user: 'invoker', sshKeyPath: '/k' } },
      ],
      tallyRemote: async (target: { name: string }) => (target.name === 'remote_digital_ocean_1' ? 20_406_837 : 14_235),
    });

    const result = await runCodexDailySpendGateTick(config, makeLogger(), NOW_MS);

    expect(result.tokensByHost.size).toBe(2);
    expect(result.tokensByHost.get('remote_digital_ocean_1')).toBe(20_406_837);
    expect(result.totalTokens).toBe(20_421_072);
  });

  it.fails('counts the owner once when a remote target points at one of its own addresses', async () => {
    const config = gateConfig({
      tallyLocal: () => 18_254,
      localAddresses: new Set(['157.245.231.246']),
      remoteTargets: [
        { name: 'remote_digital_ocean_1', connection: { host: '157.245.231.246', user: 'invoker', sshKeyPath: '/k' } },
        { name: 'remote_digital_ocean_3', connection: { host: 'h3', user: 'invoker', sshKeyPath: '/k' } },
      ],
      tallyRemote: async (target: { name: string }) => (target.name === 'remote_digital_ocean_1' ? 18_254 : 0),
    });

    const result = await runCodexDailySpendGateTick(config, makeLogger(), NOW_MS);

    expect(result.totalTokens).toBe(18_254);
    expect([...result.tokensByHost.keys()]).toEqual(['owner', 'remote_digital_ocean_3']);
  });

  it.fails('skips a remote target on the loopback address without any config', async () => {
    const tallyRemote = vi.fn(async () => 18_254);
    const config = gateConfig({
      tallyLocal: () => 18_254,
      remoteTargets: [
        { name: 'self', connection: { host: '127.0.0.1', user: 'invoker', sshKeyPath: '/k' } },
      ],
      tallyRemote,
    });

    const result = await runCodexDailySpendGateTick(config, makeLogger(), NOW_MS);

    expect(result.totalTokens).toBe(18_254);
    expect(tallyRemote).not.toHaveBeenCalled();
  });

  it('does nothing when the gate is disabled', async () => {
    const config = gateConfig({ enabled: false, tallyRemote: async () => 500_000_000 });
    const result = await runCodexDailySpendGateTick(config, makeLogger(), NOW_MS);
    expect(result.evaluated).toBe(false);
    expect(existsSync(config.statePath)).toBe(false);
  });
});

describe('Codex agents refuse to build a command while the gate is tripped', () => {
  function trippedStatePath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'codex-gate-agent-'));
    const statePath = join(dir, 'codex-spend-gate.json');
    recordCodexSpendGateTrip(statePath, {
      trippedAt: '2026-09-04T12:00:00.000Z',
      dayKey: '2026-09-04',
      tokenBudget: DEFAULT_CODEX_DAILY_TOKEN_BUDGET,
      observedTokens: 894_900_000,
      tokensByHost: { owner: 894_900_000 },
    });
    return statePath;
  }

  it('fails exec, resume, fix, and planning requests with a reviewable message', () => {
    const statePath = trippedStatePath();
    const spendGate = createCodexSpendGateReader(statePath);
    const agent = new CodexExecutionAgent({ spendGate });
    const planner = new CodexPlanningAgent({ spendGate });

    expect(() => agent.buildCommand('do the thing')).toThrow(CodexSpendGateTrippedError);
    expect(() => agent.buildResumeArgs('session-1')).toThrow(/every Codex request fails/);
    expect(() => agent.buildFixCommand('fix the thing')).toThrow(/invoker-cli spend-gate reset/);
    expect(() => planner.buildPlanningCommand('plan the thing')).toThrow(/894.9M tokens exceeds/);
  });

  it('allows requests again once the trip is cleared', () => {
    const statePath = trippedStatePath();
    const spendGate = createCodexSpendGateReader(statePath);
    const agent = new CodexExecutionAgent({ spendGate });

    expect(() => agent.buildCommand('do the thing')).toThrow(CodexSpendGateTrippedError);
    expect(clearCodexSpendGateTrip(statePath)).toBe(true);
    expect(agent.buildCommand('do the thing').cmd).toBe('codex');
  });
});
