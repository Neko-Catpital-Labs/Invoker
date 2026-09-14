import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { runCodexDailySpendGateTick, type CodexSpendGateRemoteTarget } from '../workers/spend-circuit-breaker-worker.js';
import { clearCodexSpendGateTrip, loadCodexSpendGateTrip } from '../codex-spend-gate.js';

const LIVE = process.env.INVOKER_CODEX_SPEND_GATE_LIVE === '1';

interface RemoteTargetConfig {
  host?: string;
  user?: string;
  sshKeyPath?: string;
  port?: number;
}

function readRemoteTargets(): CodexSpendGateRemoteTarget[] {
  const configPath = process.env.INVOKER_REPO_CONFIG_PATH ?? join(homedir(), '.invoker', 'config.json');
  if (!existsSync(configPath)) return [];
  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as {
    remoteTargets?: Record<string, RemoteTargetConfig>;
  };
  return Object.entries(parsed.remoteTargets ?? {})
    .filter(([, t]) => t.host && t.user && t.sshKeyPath)
    .map(([name, t]) => ({
      name,
      connection: {
        host: t.host as string,
        user: t.user as string,
        sshKeyPath: (t.sshKeyPath as string).replace(/^~\//, `${homedir()}/`),
        port: t.port,
      },
    }));
}

function logger() {
  const lines: string[] = [];
  const record = (level: string) => (message: string) => { lines.push(`${level} ${message}`); };
  return {
    lines,
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
    child: () => logger(),
  };
}

function statePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'codex-gate-live-')), 'codex-spend-gate.json');
}

describe.skipIf(!LIVE)('Codex daily spend gate against the real fleet', () => {
  const targets = readRemoteTargets();
  const nowMs = Date.now();

  it('tallies every configured host over SSH and reports a real per-host total', async () => {
    expect(targets.length).toBeGreaterThan(0);
    const log = logger();

    const result = await runCodexDailySpendGateTick(
      { enabled: true, dailyTokenBudget: Number.MAX_SAFE_INTEGER, statePath: statePath(), remoteTargets: targets },
      log as never,
      nowMs,
    );

    process.stdout.write(`\nLIVE FLEET TALLY (${new Date(nowMs).toISOString().slice(0, 10)} UTC)\n`);
    for (const [host, tokens] of [...result.tokensByHost].sort((a, b) => b[1] - a[1])) {
      process.stdout.write(`  ${host.padEnd(26)} ${tokens.toLocaleString().padStart(14)}\n`);
    }
    process.stdout.write(`  ${'TOTAL'.padEnd(26)} ${result.totalTokens.toLocaleString().padStart(14)}\n`);
    if (result.failedHosts.length > 0) {
      process.stdout.write(`  failed hosts: ${result.failedHosts.map((f) => `${f.host} (${f.reason})`).join(', ')}\n`);
    }

    expect(result.evaluated).toBe(true);
    expect(result.tokensByHost.size).toBe(targets.length + 1);
    expect(result.tripped).toBe(false);
    expect(result.failedHosts).toEqual([]);
  }, 300_000);

  it('trips on the real tally when that tally exceeds the budget, and stays tripped', async () => {
    const path = statePath();
    const log = logger();

    const first = await runCodexDailySpendGateTick(
      { enabled: true, dailyTokenBudget: 1, statePath: path, remoteTargets: targets },
      log as never,
      nowMs,
    );

    expect(first.tripped).toBe(true);
    const trip = loadCodexSpendGateTrip(path);
    expect(trip?.observedTokens).toBe(first.totalTokens);
    expect(Object.keys(trip?.tokensByHost ?? {}).length).toBe(targets.length + 1);
    expect(log.lines.some((l) => l.startsWith('error') && l.includes('TRIPPED'))).toBe(true);
    process.stdout.write(`\nTRIPPED on real tally: ${first.totalTokens.toLocaleString()} tokens > budget 1\n`);

    const second = await runCodexDailySpendGateTick(
      { enabled: true, dailyTokenBudget: 1, statePath: path, remoteTargets: targets },
      logger() as never,
      nowMs + 48 * 60 * 60_000,
    );
    expect(second.alreadyTripped).toBe(true);
    expect(second.evaluated).toBe(false);
    expect(loadCodexSpendGateTrip(path)?.observedTokens).toBe(first.totalTokens);

    expect(clearCodexSpendGateTrip(path)).toBe(true);
    expect(loadCodexSpendGateTrip(path)).toBeUndefined();
  }, 600_000);

  it('reports an unreachable host rather than counting it as zero spend', async () => {
    const log = logger();
    const result = await runCodexDailySpendGateTick(
      {
        enabled: true,
        dailyTokenBudget: Number.MAX_SAFE_INTEGER,
        statePath: statePath(),
        remoteTargets: [
          ...targets,
          { name: 'unreachable_probe', connection: { host: '198.51.100.1', user: 'invoker', sshKeyPath: '/dev/null' } },
        ],
      },
      log as never,
      nowMs,
    );

    expect(result.failedHosts.map((f) => f.host)).toContain('unreachable_probe');
    expect(result.tokensByHost.has('unreachable_probe')).toBe(false);
    process.stdout.write(`\nunreachable host surfaced: ${result.failedHosts.map((f) => f.host).join(', ')}\n`);
  }, 300_000);
});
