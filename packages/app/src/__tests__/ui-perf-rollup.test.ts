import { describe, expect, it } from 'vitest';
import {
  createRendererUiPerfCounters,
  recordRendererUiPerfMetric,
  resetRendererUiPerfCounters,
} from '../ui-perf-rollup.js';

describe('renderer UI perf rollup', () => {
  it('accumulates chat and terminal renderer markers', () => {
    const counters = createRendererUiPerfCounters();

    recordRendererUiPerfMetric(counters, 'planning_chat_input_change', {
      durationMs: 4,
      valueLength: 12,
      lineCount: 3,
    });
    recordRendererUiPerfMetric(counters, 'planning_chat_input_commit', {
      durationMs: 22,
      handlerMs: 6,
      valueLength: 14,
      lineCount: 3,
    });
    recordRendererUiPerfMetric(counters, 'planning_chat_render_commit', {
      durationMs: 19,
      valueLength: 14,
      lineCount: 5,
    });
    recordRendererUiPerfMetric(counters, 'terminal_renderer_attach', {
      durationMs: 17,
    });
    recordRendererUiPerfMetric(counters, 'terminal_renderer_output_write', {
      durationMs: 9,
      bytes: 512,
      bytesInWindow: 70_000,
      burst: true,
    });
    recordRendererUiPerfMetric(counters, 'terminal_renderer_output_seed', {
      durationMs: 24,
      bytes: 4096,
    });

    expect(counters.rendererReports).toBe(6);
    expect(counters.planningChatInputChanges).toBe(1);
    expect(counters.planningChatInputCommits).toBe(1);
    expect(counters.planningChatRenderCommits).toBe(1);
    expect(counters.maxPlanningChatInputHandlerMs).toBe(6);
    expect(counters.maxPlanningChatInputCommitMs).toBe(22);
    expect(counters.maxPlanningChatRenderCommitMs).toBe(19);
    expect(counters.maxPlanningChatValueLength).toBe(14);
    expect(counters.maxPlanningChatLineCount).toBe(5);
    expect(counters.terminalRendererAttaches).toBe(1);
    expect(counters.maxTerminalRendererAttachMs).toBe(17);
    expect(counters.terminalRendererOutputWrites).toBe(1);
    expect(counters.terminalRendererOutputBursts).toBe(1);
    expect(counters.maxTerminalRendererOutputWriteMs).toBe(9);
    expect(counters.maxTerminalRendererOutputChunkBytes).toBe(512);
    expect(counters.maxTerminalRendererOutputWindowBytes).toBe(70_000);
    expect(counters.terminalRendererOutputSeeds).toBe(1);
    expect(counters.maxTerminalRendererOutputSeedMs).toBe(24);
    expect(counters.maxTerminalRendererOutputSeedBytes).toBe(4096);
  });

  it('keeps existing renderer lag and long-task maxima and resets all fields', () => {
    const counters = createRendererUiPerfCounters();

    recordRendererUiPerfMetric(counters, 'renderer_event_loop_lag', {
      lagMs: 25,
      cumulativeLagMs: 40,
      tickDeltaMs: 1025,
      visibilityState: 'visible',
      hasFocus: true,
    });
    recordRendererUiPerfMetric(counters, 'renderer_event_loop_lag', {
      lagMs: 80,
      visibilityState: 'hidden',
    });
    recordRendererUiPerfMetric(counters, 'renderer_long_task', {
      durationMs: 120,
    });

    expect(counters.maxRendererEventLoopLagMs).toBe(25);
    expect(counters.maxRendererHiddenEventLoopLagMs).toBe(80);
    expect(counters.maxRendererCumulativeLagMs).toBe(40);
    expect(counters.maxRendererTickDeltaMs).toBe(1025);
    expect(counters.maxRendererLongTaskMs).toBe(120);

    resetRendererUiPerfCounters(counters);

    expect(counters).toEqual(createRendererUiPerfCounters());
  });
});
