import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  drainPlanningTelemetryRetries,
  logPlanningEvent,
  planningTelemetryRing,
  resetPlanningTelemetryForTests,
} from './planning-telemetry.js';

type ReportUiPerf = (metric: string, data?: Record<string, unknown>) => Promise<void>;

function installReporter(report: ReportUiPerf): void {
  (window as { invoker?: { reportUiPerf: ReportUiPerf } }).invoker = { reportUiPerf: report };
}

describe('planning telemetry', () => {
  beforeEach(() => {
    resetPlanningTelemetryForTests();
  });

  afterEach(() => {
    resetPlanningTelemetryForTests();
    delete (window as { invoker?: unknown }).invoker;
  });

  it('records events in the ring buffer and forwards them to reportUiPerf', async () => {
    const report = vi.fn(async () => {});
    installReporter(report);

    logPlanningEvent('planning_send_start', { sessionId: 's-1', turnId: 't-1' });

    const ring = planningTelemetryRing();
    expect(ring).toHaveLength(1);
    expect(ring[0].metric).toBe('planning_send_start');
    expect(ring[0].data).toEqual({ sessionId: 's-1', turnId: 't-1' });
    expect(report).toHaveBeenCalledWith('planning_send_start', { sessionId: 's-1', turnId: 't-1' });
  });

  it('queues events while shipping fails and replays them once the transport recovers', async () => {
    let failing = true;
    const shipped: Array<{ metric: string; data?: Record<string, unknown> }> = [];
    const report = vi.fn(async (metric: string, data?: Record<string, unknown>) => {
      if (failing) throw new Error('502');
      shipped.push({ metric, data });
    });
    installReporter(report);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    logPlanningEvent('planning_poll_failure', { consecutiveFailures: 1 });
    // Let the rejection land in the retry queue.
    await Promise.resolve();
    await Promise.resolve();
    expect(shipped).toHaveLength(0);

    failing = false;
    drainPlanningTelemetryRetries();
    await Promise.resolve();

    expect(shipped).toHaveLength(1);
    expect(shipped[0].metric).toBe('planning_poll_failure');
    // Replayed events carry their original client timestamp.
    expect(shipped[0].data).toMatchObject({ consecutiveFailures: 1, replayed: true });
    expect(typeof shipped[0].data?.clientTs).toBe('string');
    consoleError.mockRestore();
  });

  it('queues events logged before the bridge installs and ships them on drain', async () => {
    logPlanningEvent('planning_web_boot', { href: 'x' });

    const report = vi.fn(async () => {});
    installReporter(report);
    drainPlanningTelemetryRetries();
    await Promise.resolve();

    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toBe('planning_web_boot');
  });

  it('caps the retry queue and reports the drop count after recovery', async () => {
    const shipped: string[] = [];
    // No reporter installed: every event lands in the bounded retry queue.
    for (let i = 0; i < 130; i += 1) {
      logPlanningEvent('planning_poll_failure', { consecutiveFailures: i });
    }

    installReporter(vi.fn(async (metric: string) => {
      shipped.push(metric);
    }));
    drainPlanningTelemetryRetries();
    await Promise.resolve();

    // 100 queued survivors + 1 synthetic drop report for the 30 evicted.
    expect(shipped.filter((metric) => metric === 'planning_poll_failure')).toHaveLength(100);
    expect(shipped.filter((metric) => metric === 'planning_telemetry_dropped')).toHaveLength(1);
  });
});
