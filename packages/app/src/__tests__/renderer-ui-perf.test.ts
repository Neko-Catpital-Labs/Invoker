import { describe, it, expect } from 'vitest';
import {
  createRendererHotPathUiPerfCounters,
  recordRendererHotPathUiPerfMetric,
  resetRendererHotPathUiPerfCounters,
} from '../renderer-ui-perf.js';

describe('renderer hot-path UI perf counters', () => {
  it('rolls planning chat and xterm renderer metrics into owner stats', () => {
    const counters = createRendererHotPathUiPerfCounters();

    recordRendererHotPathUiPerfMetric(counters, 'planning_chat_input_change', {
      inputChars: 12,
      deltaChars: -4,
    });
    recordRendererHotPathUiPerfMetric(counters, 'planning_chat_render', {
      durationMs: 18,
      transcriptLines: 7,
      transcriptChars: 1200,
    });
    recordRendererHotPathUiPerfMetric(counters, 'terminal_xterm_attach', {
      durationMs: 9,
    });
    recordRendererHotPathUiPerfMetric(counters, 'terminal_xterm_snapshot_seed', {
      durationMs: 5,
      bytes: 4096,
    });
    recordRendererHotPathUiPerfMetric(counters, 'terminal_xterm_output_write', {
      durationMs: 22,
      chunksInWindow: 24,
      bytesInWindow: 48_000,
    });
    recordRendererHotPathUiPerfMetric(counters, 'terminal_xterm_fit', {
      durationMs: 4,
    });
    recordRendererHotPathUiPerfMetric(counters, 'terminal_xterm_input', {
      bytes: 6,
    });

    expect(counters).toMatchObject({
      planningChatInputReports: 1,
      planningChatRenderReports: 1,
      maxPlanningChatInputChars: 12,
      maxPlanningChatInputDeltaChars: 4,
      maxPlanningChatRenderMs: 18,
      maxPlanningChatTranscriptLines: 7,
      maxPlanningChatTranscriptChars: 1200,
      terminalXtermAttachReports: 1,
      terminalXtermSnapshotSeedReports: 1,
      terminalXtermOutputWriteReports: 1,
      terminalXtermFitReports: 1,
      terminalXtermInputReports: 1,
      maxTerminalXtermAttachMs: 9,
      maxTerminalXtermSnapshotSeedMs: 5,
      maxTerminalXtermSnapshotSeedBytes: 4096,
      maxTerminalXtermOutputWriteMs: 22,
      maxTerminalXtermOutputBurstChunks: 24,
      maxTerminalXtermOutputBurstBytes: 48_000,
      maxTerminalXtermFitMs: 4,
      maxTerminalXtermInputBytes: 6,
    });

    resetRendererHotPathUiPerfCounters(counters);

    expect(counters).toMatchObject({
      planningChatInputReports: 0,
      planningChatRenderReports: 0,
      terminalXtermAttachReports: 0,
      terminalXtermOutputWriteReports: 0,
      maxPlanningChatRenderMs: 0,
      maxTerminalXtermOutputBurstBytes: 0,
    });
  });
});
