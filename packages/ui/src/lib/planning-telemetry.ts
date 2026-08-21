/**
 * Planning interaction telemetry.
 *
 * Every event goes three places:
 * 1. A ring buffer on `window.__invokerPlanningLog` for in-tab forensics.
 * 2. The console, so devtools show the interaction timeline.
 * 3. `window.invoker.reportUiPerf` — the existing ui-perf pipeline; the owner
 *    persists each event to the activity log (source `ui-perf`), where it is
 *    queryable via `invoker query ui-perf` / `invoker:get-activity-logs`.
 *
 * Events that fail to ship (transport down mid-incident) are queued and
 * retried on an interval, so the server record survives transient 502s —
 * exactly the windows we most need logs from. The queue is bounded; when it
 * overflows, the oldest events are dropped and the drop count is reported
 * once the transport recovers.
 */

export interface PlanningTelemetryEntry {
  ts: string;
  metric: string;
  data: Record<string, unknown>;
}

declare global {
  interface Window {
    /** In-tab forensic ring buffer of recent planning telemetry (newest last). */
    __invokerPlanningLog?: PlanningTelemetryEntry[];
  }
}

const RING_MAX = 300;
const RETRY_MAX = 100;
const RETRY_INTERVAL_MS = 10_000;

const ring: PlanningTelemetryEntry[] = [];
const retryQueue: PlanningTelemetryEntry[] = [];
let droppedRetries = 0;
let retryTimer: number | null = null;

if (typeof window !== 'undefined') {
  window.__invokerPlanningLog = ring;
}

function enqueueRetry(entry: PlanningTelemetryEntry): void {
  retryQueue.push(entry);
  if (retryQueue.length > RETRY_MAX) {
    retryQueue.shift();
    droppedRetries += 1;
  }
  if (retryTimer === null && typeof window !== 'undefined') {
    retryTimer = window.setInterval(drainPlanningTelemetryRetries, RETRY_INTERVAL_MS);
  }
}

function ship(entry: PlanningTelemetryEntry, replayed: boolean): void {
  const report = typeof window !== 'undefined' ? window.invoker?.reportUiPerf : undefined;
  if (!report) {
    // No bridge yet (or a non-browser environment): keep the event for retry
    // so early-boot events still reach the server once the bridge installs.
    enqueueRetry(entry);
    return;
  }
  const payload = replayed ? { ...entry.data, clientTs: entry.ts, replayed: true } : entry.data;
  Promise.resolve(report(entry.metric, payload)).catch((err: unknown) => {
    console.error('[planning] telemetry ship failed', entry.metric, err);
    enqueueRetry(entry);
  });
}

/** Retry loop tick; exported for tests. */
export function drainPlanningTelemetryRetries(): void {
  if (retryQueue.length === 0 && droppedRetries === 0) {
    if (retryTimer !== null && typeof window !== 'undefined') {
      window.clearInterval(retryTimer);
      retryTimer = null;
    }
    return;
  }
  const report = typeof window !== 'undefined' ? window.invoker?.reportUiPerf : undefined;
  if (!report) return;
  if (droppedRetries > 0) {
    const dropped = droppedRetries;
    droppedRetries = 0;
    ship({ ts: new Date().toISOString(), metric: 'planning_telemetry_dropped', data: { droppedCount: dropped } }, false);
  }
  const pending = retryQueue.splice(0, retryQueue.length);
  for (const entry of pending) ship(entry, true);
}

/**
 * Record one planning interaction event. Fire-and-forget; never throws.
 * Metric names are snake_case to match the existing `ui-perf` rows.
 */
export function logPlanningEvent(metric: string, data: Record<string, unknown> = {}): void {
  const entry: PlanningTelemetryEntry = { ts: new Date().toISOString(), metric, data };
  ring.push(entry);
  if (ring.length > RING_MAX) ring.shift();
  console.info('[planning]', metric, data);
  ship(entry, false);
}

/** Test hook: clears the ring, the retry queue, and the retry timer. */
export function resetPlanningTelemetryForTests(): void {
  ring.length = 0;
  retryQueue.length = 0;
  droppedRetries = 0;
  if (retryTimer !== null && typeof window !== 'undefined') {
    window.clearInterval(retryTimer);
    retryTimer = null;
  }
}

/** Read-only view of the ring buffer (newest last); exported for tests. */
export function planningTelemetryRing(): readonly PlanningTelemetryEntry[] {
  return ring;
}
