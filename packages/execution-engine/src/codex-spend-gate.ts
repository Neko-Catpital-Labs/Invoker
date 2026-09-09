import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { listCodexSessionFiles, summarizeCodexSessionFile } from './spend-attribution.js';
import { shellPosixSingleQuote } from './ssh-git-exec.js';

export const DEFAULT_CODEX_DAILY_TOKEN_BUDGET = 100_000_000;

export const CODEX_SPEND_GATE_ENV_STATE_PATH = 'INVOKER_CODEX_SPEND_GATE_PATH';

export interface CodexSpendGateTrip {
  readonly trippedAt: string;
  readonly dayKey: string;
  readonly tokenBudget: number;
  readonly observedTokens: number;
  readonly tokensByHost: Readonly<Record<string, number>>;
}

export function defaultCodexSpendGatePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[CODEX_SPEND_GATE_ENV_STATE_PATH]?.trim();
  if (override) return override;
  const home = env.INVOKER_HOME?.trim() || join(homedir(), '.invoker');
  return join(home, 'codex-spend-gate.json');
}

export function loadCodexSpendGateTrip(statePath: string): CodexSpendGateTrip | undefined {
  if (!existsSync(statePath)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(statePath, 'utf8');
  } catch (error) {
    throw new Error(
      `codex spend gate state at ${statePath} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `codex spend gate state at ${statePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const trip = parsed as Partial<CodexSpendGateTrip> | null;
  if (!trip || typeof trip.trippedAt !== 'string' || typeof trip.observedTokens !== 'number') {
    return undefined;
  }
  return {
    trippedAt: trip.trippedAt,
    dayKey: typeof trip.dayKey === 'string' ? trip.dayKey : '',
    tokenBudget: typeof trip.tokenBudget === 'number' ? trip.tokenBudget : DEFAULT_CODEX_DAILY_TOKEN_BUDGET,
    observedTokens: trip.observedTokens,
    tokensByHost: (trip.tokensByHost ?? {}) as Readonly<Record<string, number>>,
  };
}

export function recordCodexSpendGateTrip(statePath: string, trip: CodexSpendGateTrip): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(trip, null, 2)}\n`, 'utf8');
}

export function clearCodexSpendGateTrip(statePath: string): boolean {
  if (!existsSync(statePath)) return false;
  rmSync(statePath);
  return true;
}

function formatTokens(tokens: number): string {
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export function codexSpendGateBlockMessage(trip: CodexSpendGateTrip, statePath: string): string {
  const hosts = Object.entries(trip.tokensByHost)
    .sort((a, b) => b[1] - a[1])
    .map(([host, tokens]) => `${host}=${formatTokens(tokens)}`)
    .join(' ');
  return [
    'Codex is shut off by the daily spend gate and every Codex request fails until a human reviews the sessions.',
    `Tripped ${trip.trippedAt} for day ${trip.dayKey}: ${formatTokens(trip.observedTokens)} tokens exceeds the ${formatTokens(trip.tokenBudget)} daily budget.`,
    hosts.length > 0 ? `Per host: ${hosts}.` : '',
    `Review the sessions, then clear it with: invoker-cli spend-gate reset  (state file: ${statePath})`,
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

export function codexSpendGateDayKey(nowMs: number): string {
  const d = new Date(nowMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function codexSessionDayDir(sessionRootDir: string, nowMs: number): string {
  const [year, month, day] = codexSpendGateDayKey(nowMs).split('-');
  return join(sessionRootDir, year, month, day);
}

export function defaultCodexSessionRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME?.trim() || homedir();
  return join(home, '.codex', 'sessions');
}

export function tallyCodexTokensForDay(sessionRootDir: string, nowMs: number): number {
  const dayDir = codexSessionDayDir(sessionRootDir, nowMs);
  let total = 0;
  for (const file of listCodexSessionFiles(dayDir)) {
    const summary = summarizeCodexSessionFile(file);
    if (typeof summary.totalTokens === 'number') total += summary.totalTokens;
  }
  return total;
}

export function buildRemoteCodexTallyScript(sessionRootDir: string, nowMs: number): string {
  const dayDirQ = shellPosixSingleQuote(codexSessionDayDir(sessionRootDir, nowMs));
  return `set -euo pipefail
DAY_DIR=${dayDirQ}
python3 - "$DAY_DIR" <<'PY'
import json, os, sys

day_dir = sys.argv[1]
total = 0
if os.path.isdir(day_dir):
    for name in os.listdir(day_dir):
        if not (name.startswith('rollout-') and name.endswith('.jsonl')):
            continue
        session_total = 0
        try:
            with open(os.path.join(day_dir, name), 'r', errors='replace') as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except ValueError:
                        continue
                    if entry.get('type') != 'event_msg':
                        continue
                    payload = entry.get('payload') or {}
                    if payload.get('type') != 'token_count':
                        continue
                    usage = (payload.get('info') or {}).get('total_token_usage') or {}
                    if isinstance(usage.get('total_tokens'), int):
                        session_total = usage['total_tokens']
        except OSError as err:
            print('TALLY_ERROR %s' % err, file=sys.stderr)
            continue
        total += session_total
print(total)
PY
`;
}

export function parseRemoteCodexTally(stdout: string): number {
  const line = stdout.trim().split('\n').filter((l) => l.trim().length > 0).pop() ?? '';
  const parsed = Number.parseInt(line.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`remote codex tally returned unparseable output: ${JSON.stringify(stdout.slice(0, 200))}`);
  }
  return parsed;
}

export interface CodexDailySpendEvaluation {
  readonly totalTokens: number;
  readonly tokenBudget: number;
  readonly exceeded: boolean;
}

export function evaluateCodexDailySpend(
  tokensByHost: ReadonlyMap<string, number>,
  tokenBudget: number,
): CodexDailySpendEvaluation {
  let totalTokens = 0;
  for (const tokens of tokensByHost.values()) totalTokens += tokens;
  return { totalTokens, tokenBudget, exceeded: tokenBudget > 0 && totalTokens > tokenBudget };
}

export class CodexSpendGateTrippedError extends Error {
  readonly trip: CodexSpendGateTrip;

  constructor(message: string, trip: CodexSpendGateTrip) {
    super(message);
    this.name = 'CodexSpendGateTrippedError';
    this.trip = trip;
  }
}

export interface CodexSpendGateReader {
  assertOpen(): void;
}

export function createCodexSpendGateReader(statePath?: string): CodexSpendGateReader {
  return {
    assertOpen(): void {
      const path = statePath ?? defaultCodexSpendGatePath();
      const trip = loadCodexSpendGateTrip(path);
      if (!trip) return;
      throw new CodexSpendGateTrippedError(codexSpendGateBlockMessage(trip, path), trip);
    },
  };
}
