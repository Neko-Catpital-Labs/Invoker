/**
 * Thresholded terminal UI-perf reporters for main-process beachball forensics.
 *
 * Telemetry only — does not change terminal write/resize/persist behavior.
 */

export const TERMINAL_WRITE_SLOW_MS = 50;
export const TERMINAL_RESIZE_SLOW_MS = 50;
export const TERMINAL_SESSION_UPSERT_SLOW_MS = 25;
export const TERMINAL_UPSERT_BURST_COUNT = 20;
export const TERMINAL_UPSERT_BURST_WINDOW_MS = 1000;
export const TERMINAL_PERF_THROTTLE_MS = 1000;

export type TerminalUiPerfSink = {
  writeActivityLog: (source: string, level: string, message: string) => void;
  onSlowMetric?: (metric: string, data: Record<string, unknown>) => void;
};

export type TerminalUiPerfReporter = {
  recordWrite: (durationMs: number, extra: Record<string, unknown>, sink: TerminalUiPerfSink) => void;
  recordResize: (durationMs: number, extra: Record<string, unknown>, sink: TerminalUiPerfSink) => void;
  recordUpsert: (durationMs: number, extra: Record<string, unknown>, sink: TerminalUiPerfSink) => void;
  reset: () => void;
};

export function createTerminalUiPerfReporter(options?: {
  writeSlowMs?: number;
  resizeSlowMs?: number;
  upsertSlowMs?: number;
  upsertBurstCount?: number;
  upsertBurstWindowMs?: number;
  throttleMs?: number;
  now?: () => number;
}): TerminalUiPerfReporter {
  const writeSlowMs = options?.writeSlowMs ?? TERMINAL_WRITE_SLOW_MS;
  const resizeSlowMs = options?.resizeSlowMs ?? TERMINAL_RESIZE_SLOW_MS;
  const upsertSlowMs = options?.upsertSlowMs ?? TERMINAL_SESSION_UPSERT_SLOW_MS;
  const upsertBurstCount = options?.upsertBurstCount ?? TERMINAL_UPSERT_BURST_COUNT;
  const upsertBurstWindowMs = options?.upsertBurstWindowMs ?? TERMINAL_UPSERT_BURST_WINDOW_MS;
  const throttleMs = options?.throttleMs ?? TERMINAL_PERF_THROTTLE_MS;
  const nowFn = options?.now ?? (() => Date.now());

  const lastEmitByMetric = new Map<string, number>();
  let upsertWindowStartedAt = 0;
  let upsertsInWindow = 0;

  const shouldEmit = (metric: string, at: number): boolean => {
    const prev = lastEmitByMetric.get(metric) ?? 0;
    if (at - prev < throttleMs) return false;
    lastEmitByMetric.set(metric, at);
    return true;
  };

  const emit = (sink: TerminalUiPerfSink, metric: string, data: Record<string, unknown>): void => {
    const payload = {
      ts: new Date().toISOString(),
      metric,
      ...data,
    };
    try {
      sink.writeActivityLog('ui-perf', 'info', JSON.stringify(payload));
    } catch {
      // DB might be locked
    }
    sink.onSlowMetric?.(metric, data);
  };

  return {
    recordWrite(durationMs, extra, sink) {
      if (durationMs < writeSlowMs) return;
      const at = nowFn();
      if (!shouldEmit('terminal_write_slow', at)) return;
      emit(sink, 'terminal_write_slow', {
        durationMs: Math.round(durationMs),
        ...extra,
      });
    },
    recordResize(durationMs, extra, sink) {
      if (durationMs < resizeSlowMs) return;
      const at = nowFn();
      if (!shouldEmit('terminal_resize_slow', at)) return;
      emit(sink, 'terminal_resize_slow', {
        durationMs: Math.round(durationMs),
        ...extra,
      });
    },
    recordUpsert(durationMs, extra, sink) {
      const at = nowFn();
      if (upsertWindowStartedAt === 0 || at - upsertWindowStartedAt >= upsertBurstWindowMs) {
        upsertWindowStartedAt = at;
        upsertsInWindow = 0;
      }
      upsertsInWindow += 1;

      const slow = durationMs >= upsertSlowMs;
      const burst = upsertsInWindow >= upsertBurstCount;
      if (!slow && !burst) return;
      if (!shouldEmit('terminal_session_upsert_slow', at)) return;
      emit(sink, 'terminal_session_upsert_slow', {
        durationMs: Math.round(durationMs),
        upsertsInWindow,
        upsertBurstWindowMs,
        slow,
        burst,
        ...extra,
      });
    },
    reset() {
      lastEmitByMetric.clear();
      upsertWindowStartedAt = 0;
      upsertsInWindow = 0;
    },
  };
}
