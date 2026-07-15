import { describe, it, expect } from 'vitest';
import {
  createRendererUiPerfCounters,
  recordRendererUiPerfMetric,
  resetRendererUiPerfCounters,
} from '../renderer-ui-perf.js';

describe('renderer ui perf counters', () => {
  it('aggregates renderer lag, planning chat, and embedded terminal markers', () => {
    const counters = createRendererUiPerfCounters();

    recordRendererUiPerfMetric(counters, 'renderer_event_loop_lag', {
      lagMs: 300,
      cumulativeLagMs: 450,
      tickDeltaMs: 1300,
      visibilityState: 'visible',
      hasFocus: true,
    });
    recordRendererUiPerfMetric(counters, 'renderer_event_loop_lag', {
      lagMs: 900,
      visibilityState: 'hidden',
      hasFocus: false,
    });
    recordRendererUiPerfMetric(counters, 'renderer_long_task', { durationMs: 250 });
    recordRendererUiPerfMetric(counters, 'planning_typing_lag_baseline', { lagMs: 19 });
    recordRendererUiPerfMetric(counters, 'planning_chat_input_change', { handlerDurationMs: 12 });
    recordRendererUiPerfMetric(counters, 'planning_chat_input_commit', { durationMs: 34 });
    recordRendererUiPerfMetric(counters, 'planning_chat_transcript_commit', {
      durationMs: 56,
      lineCount: 9,
      transcriptChars: 1234,
    });
    recordRendererUiPerfMetric(counters, 'planning_chat_transcript_autoscroll', { durationMs: 7 });
    recordRendererUiPerfMetric(counters, 'planning_chat_submit', {});
    recordRendererUiPerfMetric(counters, 'embedded_terminal_attach', { durationMs: 44 });
    recordRendererUiPerfMetric(counters, 'embedded_terminal_input', { durationMs: 3, bytes: 5 });
    recordRendererUiPerfMetric(counters, 'embedded_terminal_output_write', { durationMs: 80, bytes: 4096 });
    recordRendererUiPerfMetric(counters, 'embedded_terminal_resize', { durationMs: 18 });
    recordRendererUiPerfMetric(counters, 'embedded_terminal_snapshot_write', { durationMs: 90, bytes: 8192 });

    expect(counters.rendererReports).toBe(14);
    expect(counters.maxRendererEventLoopLagMs).toBe(300);
    expect(counters.maxRendererHiddenEventLoopLagMs).toBe(900);
    expect(counters.maxRendererCumulativeLagMs).toBe(450);
    expect(counters.maxRendererTickDeltaMs).toBe(1300);
    expect(counters.maxRendererLongTaskMs).toBe(250);
    expect(counters.planningTypingLagReports).toBe(1);
    expect(counters.maxPlanningTypingLagMs).toBe(19);
    expect(counters.planningChatInputChangeReports).toBe(1);
    expect(counters.maxPlanningChatInputHandlerMs).toBe(12);
    expect(counters.planningChatInputCommitReports).toBe(1);
    expect(counters.maxPlanningChatInputCommitMs).toBe(34);
    expect(counters.planningChatTranscriptCommitReports).toBe(1);
    expect(counters.maxPlanningChatTranscriptCommitMs).toBe(56);
    expect(counters.maxPlanningChatTranscriptLines).toBe(9);
    expect(counters.maxPlanningChatTranscriptChars).toBe(1234);
    expect(counters.planningChatTranscriptAutoscrollReports).toBe(1);
    expect(counters.maxPlanningChatTranscriptAutoscrollMs).toBe(7);
    expect(counters.planningChatSubmits).toBe(1);
    expect(counters.embeddedTerminalAttachReports).toBe(1);
    expect(counters.maxEmbeddedTerminalAttachMs).toBe(44);
    expect(counters.embeddedTerminalInputReports).toBe(1);
    expect(counters.maxEmbeddedTerminalInputMs).toBe(3);
    expect(counters.maxEmbeddedTerminalInputBytes).toBe(5);
    expect(counters.embeddedTerminalOutputWriteReports).toBe(1);
    expect(counters.maxEmbeddedTerminalOutputWriteMs).toBe(80);
    expect(counters.maxEmbeddedTerminalOutputWriteBytes).toBe(4096);
    expect(counters.embeddedTerminalResizeReports).toBe(1);
    expect(counters.maxEmbeddedTerminalResizeMs).toBe(18);
    expect(counters.embeddedTerminalSnapshotWriteReports).toBe(1);
    expect(counters.maxEmbeddedTerminalSnapshotWriteMs).toBe(90);
    expect(counters.maxEmbeddedTerminalSnapshotBytes).toBe(8192);

    resetRendererUiPerfCounters(counters);

    expect(counters.rendererReports).toBe(0);
    expect(counters.maxPlanningTypingLagMs).toBe(0);
    expect(counters.maxPlanningChatInputCommitMs).toBe(0);
    expect(counters.maxEmbeddedTerminalOutputWriteBytes).toBe(0);
  });
});
