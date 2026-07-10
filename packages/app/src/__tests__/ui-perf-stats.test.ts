import { describe, expect, it } from 'vitest';
import {
  createUiPerfStats,
  recordUiPerfMetric,
  resetUiPerfStatsAccumulator,
} from '../ui-perf-stats.js';

describe('ui perf stats accumulator', () => {
  it('rolls up planning chat and embedded terminal metrics', () => {
    const stats = createUiPerfStats();

    recordUiPerfMetric(stats, 'planning_chat_input_change', {
      handlerMs: 7.5,
      valueLength: 42,
      deltaChars: -3,
    });
    recordUiPerfMetric(stats, 'planning_chat_render_commit', {
      durationMs: 18.2,
      lineCount: 9,
    });
    recordUiPerfMetric(stats, 'embedded_terminal_attach', {
      durationMs: 11.1,
    });
    recordUiPerfMetric(stats, 'embedded_terminal_input_write', {
      bytes: 4,
    });
    recordUiPerfMetric(stats, 'embedded_terminal_output_write', {
      source: 'snapshot',
      bytes: 10,
      durationMs: 3.1,
    });
    recordUiPerfMetric(stats, 'embedded_terminal_output_write', {
      source: 'live',
      bytes: 25,
      durationMs: 4.4,
    });

    expect(stats).toMatchObject({
      planningChatInputChanges: 1,
      planningChatInputCharsChanged: 3,
      maxPlanningChatInputHandlerMs: 7.5,
      maxPlanningChatInputValueLength: 42,
      planningChatRenderCommits: 1,
      maxPlanningChatRenderCommitMs: 18.2,
      maxPlanningChatRenderLineCount: 9,
      embeddedTerminalAttaches: 1,
      maxEmbeddedTerminalAttachMs: 11.1,
      embeddedTerminalInputWrites: 1,
      embeddedTerminalInputBytes: 4,
      maxEmbeddedTerminalInputBytes: 4,
      embeddedTerminalOutputWrites: 2,
      embeddedTerminalOutputBytes: 35,
      embeddedTerminalSnapshotOutputBytes: 10,
      embeddedTerminalLiveOutputBytes: 25,
      maxEmbeddedTerminalOutputBytes: 25,
      maxEmbeddedTerminalOutputWriteMs: 4.4,
    });
  });

  it('preserves existing renderer long-task and event-loop rollups', () => {
    const stats = createUiPerfStats();

    recordUiPerfMetric(stats, 'renderer_event_loop_lag', {
      lagMs: 123,
      cumulativeLagMs: 150,
      tickDeltaMs: 1123,
      visibilityState: 'visible',
      hasFocus: true,
    });
    recordUiPerfMetric(stats, 'renderer_event_loop_lag', {
      lagMs: 300,
      visibilityState: 'hidden',
      hasFocus: false,
    });
    recordUiPerfMetric(stats, 'renderer_long_task', { durationMs: 456 });

    expect(stats.maxRendererEventLoopLagMs).toBe(123);
    expect(stats.maxRendererHiddenEventLoopLagMs).toBe(300);
    expect(stats.maxRendererCumulativeLagMs).toBe(150);
    expect(stats.maxRendererTickDeltaMs).toBe(1123);
    expect(stats.maxRendererLongTaskMs).toBe(456);
  });

  it('resets the extended accumulator fields', () => {
    const stats = createUiPerfStats();
    recordUiPerfMetric(stats, 'planning_chat_input_change', {
      handlerMs: 2,
      valueLength: 8,
      deltaChars: 8,
    });
    recordUiPerfMetric(stats, 'embedded_terminal_output_write', {
      source: 'live',
      bytes: 12,
      durationMs: 1,
    });

    resetUiPerfStatsAccumulator(stats);

    expect(stats).toEqual(createUiPerfStats());
  });
});
