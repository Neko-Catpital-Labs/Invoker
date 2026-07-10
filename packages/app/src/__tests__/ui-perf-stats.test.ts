import { describe, expect, it } from 'vitest';
import {
  createRendererUiPerfCounters,
  recordRendererUiPerfMetric,
  resetRendererUiPerfCounters,
} from '../ui-perf-stats.js';

describe('renderer ui perf stats', () => {
  it('keeps existing renderer lag and long-task rollups', () => {
    const counters = createRendererUiPerfCounters();

    recordRendererUiPerfMetric(counters, 'renderer_event_loop_lag', {
      lagMs: 12,
      cumulativeLagMs: 18,
      tickDeltaMs: 1012,
      visibilityState: 'visible',
      hasFocus: true,
    });
    recordRendererUiPerfMetric(counters, 'renderer_event_loop_lag', {
      lagMs: 30,
      visibilityState: 'hidden',
      hasFocus: false,
    });
    recordRendererUiPerfMetric(counters, 'renderer_long_task', { durationMs: 220 });

    expect(counters.rendererReports).toBe(3);
    expect(counters.maxRendererEventLoopLagMs).toBe(12);
    expect(counters.maxRendererHiddenEventLoopLagMs).toBe(30);
    expect(counters.maxRendererCumulativeLagMs).toBe(18);
    expect(counters.maxRendererTickDeltaMs).toBe(1012);
    expect(counters.maxRendererLongTaskMs).toBe(220);
  });

  it('aggregates planning chat and renderer terminal metrics', () => {
    const counters = createRendererUiPerfCounters();

    recordRendererUiPerfMetric(counters, 'planning_chat_input_change', {
      durationMs: 4.5,
      valueLength: 120,
      lineCount: 5,
    });
    recordRendererUiPerfMetric(counters, 'planning_chat_render_commit', {
      durationMs: 9,
      inputToCommitMs: 14,
      valueLength: 125,
      lineCount: 6,
    });
    recordRendererUiPerfMetric(counters, 'terminal_attach', { durationMs: 11 });
    recordRendererUiPerfMetric(counters, 'terminal_snapshot_seed', { durationMs: 7, bytes: 4096 });
    recordRendererUiPerfMetric(counters, 'terminal_output_write', { durationMs: 13, bytes: 8192 });
    recordRendererUiPerfMetric(counters, 'terminal_output_burst', {
      outputCount: 25,
      bytes: 65536,
      maxWriteMs: 6,
    });

    expect(counters.planningChatInputChangeCount).toBe(1);
    expect(counters.planningChatRenderCommitCount).toBe(1);
    expect(counters.maxPlanningChatInputChangeMs).toBe(4.5);
    expect(counters.maxPlanningChatInputToCommitMs).toBe(14);
    expect(counters.maxPlanningChatRenderCommitMs).toBe(9);
    expect(counters.maxPlanningChatValueLength).toBe(125);
    expect(counters.maxPlanningChatLineCount).toBe(6);
    expect(counters.rendererTerminalAttachCount).toBe(1);
    expect(counters.rendererTerminalSnapshotSeedCount).toBe(1);
    expect(counters.rendererTerminalOutputWriteCount).toBe(1);
    expect(counters.rendererTerminalOutputBurstCount).toBe(1);
    expect(counters.maxRendererTerminalAttachMs).toBe(11);
    expect(counters.maxRendererTerminalSnapshotSeedMs).toBe(7);
    expect(counters.maxRendererTerminalSnapshotSeedBytes).toBe(4096);
    expect(counters.maxRendererTerminalOutputWriteMs).toBe(13);
    expect(counters.maxRendererTerminalOutputChunkBytes).toBe(8192);
    expect(counters.maxRendererTerminalOutputBurstCount).toBe(25);
    expect(counters.maxRendererTerminalOutputBurstBytes).toBe(65536);
    expect(counters.maxRendererTerminalOutputBurstWriteMs).toBe(6);
    expect(counters.rendererTerminalOutputBurstBytes).toBe(65536);
  });

  it('resets all renderer counters', () => {
    const counters = createRendererUiPerfCounters();
    recordRendererUiPerfMetric(counters, 'planning_chat_input_change', { durationMs: 4 });
    recordRendererUiPerfMetric(counters, 'terminal_output_burst', { outputCount: 20, bytes: 100 });

    resetRendererUiPerfCounters(counters);

    expect(counters).toEqual(createRendererUiPerfCounters());
  });
});
