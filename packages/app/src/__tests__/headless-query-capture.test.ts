import { describe, expect, it, vi } from 'vitest';

import { runHeadless, type HeadlessDeps } from '../headless.js';
import {
  createUiPerfTelemetryStats,
  recordUiPerfTelemetryReport,
} from '../ui-perf-telemetry.js';

describe('headless query capture', () => {
  it('captures planning ui-perf metrics in jsonl output without resetting stats', async () => {
    const stats = createUiPerfTelemetryStats();
    recordUiPerfTelemetryReport(stats, 'renderer_event_loop_lag', { lagMs: 11 });
    recordUiPerfTelemetryReport(stats, 'planning_typing_lag_baseline', {
      scenario: 'many-chats-many-messages-typing',
      sessionCount: 4,
      transcriptSizeBytes: 4096,
      transcriptMessageCount: 40,
      activeSurface: 'planning',
      lagMs: 44,
    });
    const resetUiPerfStats = vi.fn();
    const deps = {
      getUiPerfStats: () => ({
        ownerMode: 'local',
        ts: '2026-07-13T00:00:00.000Z',
        ...stats,
      }),
      resetUiPerfStats,
    } as unknown as HeadlessDeps;
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let written = '';
    try {
      await runHeadless(['query', 'ui-perf', '--output', 'jsonl'], deps);
      written = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
    } finally {
      stdout.mockRestore();
    }

    expect(resetUiPerfStats).not.toHaveBeenCalled();
    const payload = JSON.parse(written.trim()) as Record<string, unknown>;
    expect(payload).toEqual(expect.objectContaining({
      maxRendererEventLoopLagMs: 11,
      planningTypingLagReports: 1,
      maxPlanningTypingLagMs: 44,
    }));
    expect(payload.maxPlanningTypingLagContext).toEqual(expect.objectContaining({
      scenario: 'many-chats-many-messages-typing',
      sessionCount: 4,
      transcriptSizeBytes: 4096,
      transcriptMessageCount: 40,
      activeSurface: 'planning',
      lagMs: 44,
    }));
  });
});
