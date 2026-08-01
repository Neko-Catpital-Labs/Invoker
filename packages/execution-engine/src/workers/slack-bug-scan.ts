export const DEFAULT_SLACK_BUG_SCAN_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_SLACK_BUG_SCAN_MAX_PER_DAY = 5;
export const DEFAULT_SLACK_BUG_SCAN_MAX_PER_TICK = 1;

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

export function resolveSlackBugScanIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveInt(env.INVOKER_SLACK_BUG_SCAN_INTERVAL_MS, DEFAULT_SLACK_BUG_SCAN_INTERVAL_MS);
}

export function resolveSlackBugScanMaxPerDay(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveInt(env.INVOKER_SLACK_BUG_SCAN_MAX_PER_DAY, DEFAULT_SLACK_BUG_SCAN_MAX_PER_DAY);
}

export function resolveSlackBugScanMaxPerTick(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveInt(env.INVOKER_SLACK_BUG_SCAN_MAX_PER_TICK, DEFAULT_SLACK_BUG_SCAN_MAX_PER_TICK);
}
