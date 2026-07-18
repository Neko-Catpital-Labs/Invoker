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

export type TerminalUiPerfCounters = {
  maxTerminalWriteMs: number;
  maxTerminalResizeMs: number;
  maxTerminalSessionUpsertMs: number;
  terminalWriteSlowCount: number;
  terminalResizeSlowCount: number;
  terminalSessionUpsertSlowCount: number;
};

export function createTerminalUiPerfCounters(): TerminalUiPerfCounters {
  return {
    maxTerminalWriteMs: 0,
    maxTerminalResizeMs: 0,
    maxTerminalSessionUpsertMs: 0,
    terminalWriteSlowCount: 0,
    terminalResizeSlowCount: 0,
    terminalSessionUpsertSlowCount: 0,
  };
}

export function resetTerminalUiPerfCounters(counters: TerminalUiPerfCounters): void {
  counters.maxTerminalWriteMs = 0;
  counters.maxTerminalResizeMs = 0;
  counters.maxTerminalSessionUpsertMs = 0;
  counters.terminalWriteSlowCount = 0;
  counters.terminalResizeSlowCount = 0;
  counters.terminalSessionUpsertSlowCount = 0;
}

export function createTerminalUiPerfSink(
  writeActivityLog: (source: string, level: string, message: string) => void,
  counters: TerminalUiPerfCounters,
): TerminalUiPerfSink {
  return {
    writeActivityLog,
    onSlowMetric: (metric, data) => {
      const durationMs = typeof data.durationMs === 'number' ? data.durationMs : 0;
      if (metric === 'terminal_write_slow') {
        counters.terminalWriteSlowCount += 1;
        counters.maxTerminalWriteMs = Math.max(counters.maxTerminalWriteMs, durationMs);
      } else if (metric === 'terminal_resize_slow') {
        counters.terminalResizeSlowCount += 1;
        counters.maxTerminalResizeMs = Math.max(counters.maxTerminalResizeMs, durationMs);
      } else if (metric === 'terminal_session_upsert_slow') {
        counters.terminalSessionUpsertSlowCount += 1;
        counters.maxTerminalSessionUpsertMs = Math.max(counters.maxTerminalSessionUpsertMs, durationMs);
      }
    },
  };
}

export function timeTerminalWrite<T>(
  write: () => T,
  counters: TerminalUiPerfCounters,
  reporter: TerminalUiPerfReporter,
  sink: TerminalUiPerfSink,
  extra: Record<string, unknown>,
): T {
  const startedAt = performance.now();
  const result = write();
  const durationMs = performance.now() - startedAt;
  counters.maxTerminalWriteMs = Math.max(counters.maxTerminalWriteMs, durationMs);
  reporter.recordWrite(durationMs, extra, sink);
  return result;
}

export function timeTerminalResize<T>(
  resize: () => T,
  counters: TerminalUiPerfCounters,
  reporter: TerminalUiPerfReporter,
  sink: TerminalUiPerfSink,
  extra: Record<string, unknown>,
): T {
  const startedAt = performance.now();
  const result = resize();
  const durationMs = performance.now() - startedAt;
  counters.maxTerminalResizeMs = Math.max(counters.maxTerminalResizeMs, durationMs);
  reporter.recordResize(durationMs, extra, sink);
  return result;
}

export function timeTerminalSessionUpsert(
  upsert: () => void,
  counters: TerminalUiPerfCounters,
  reporter: TerminalUiPerfReporter,
  sink: TerminalUiPerfSink,
  extra: Record<string, unknown>,
): void {
  const startedAt = performance.now();
  upsert();
  const durationMs = performance.now() - startedAt;
  counters.maxTerminalSessionUpsertMs = Math.max(counters.maxTerminalSessionUpsertMs, durationMs);
  reporter.recordUpsert(durationMs, extra, sink);
}

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
