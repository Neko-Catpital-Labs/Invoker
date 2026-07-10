import { describe, expect, it } from 'vitest';
import {
  createUiPerfHotPathCounters,
  recordUiPerfHotPathMetric,
  resetUiPerfHotPathCounters,
} from '../ui-perf-rollup.js';

describe('ui perf hot path rollup', () => {
  it('aggregates planning chat markers', () => {
    const counters = createUiPerfHotPathCounters();

    recordUiPerfHotPathMetric(counters, 'planning_chat_input', {
      durationMs: 7,
      inputLength: 12,
      lineCount: 3,
    });
    recordUiPerfHotPathMetric(counters, 'planning_chat_render', {
      durationMs: 19,
      inputLength: 5,
      lineCount: 4,
    });

    expect(counters.planningChatInputReports).toBe(1);
    expect(counters.planningChatRenderReports).toBe(1);
    expect(counters.maxPlanningChatInputMs).toBe(7);
    expect(counters.maxPlanningChatRenderMs).toBe(19);
    expect(counters.maxPlanningChatInputLength).toBe(12);
    expect(counters.maxPlanningChatLineCount).toBe(4);
  });

  it('aggregates terminal xterm markers and resets them', () => {
    const counters = createUiPerfHotPathCounters();

    recordUiPerfHotPathMetric(counters, 'terminal_xterm_attach', { durationMs: 11 });
    recordUiPerfHotPathMetric(counters, 'terminal_xterm_snapshot_seed', { durationMs: 9, bytes: 50 });
    recordUiPerfHotPathMetric(counters, 'terminal_xterm_output', {
      durationMs: 15,
      bytes: 20,
      bytesInWindow: 120,
      chunksInWindow: 6,
    });
    recordUiPerfHotPathMetric(counters, 'terminal_xterm_input', { durationMs: 4, bytes: 3 });
    recordUiPerfHotPathMetric(counters, 'terminal_xterm_fit', { durationMs: 21 });

    expect(counters.terminalXtermAttachReports).toBe(1);
    expect(counters.terminalXtermSnapshotSeedReports).toBe(1);
    expect(counters.terminalXtermOutputReports).toBe(1);
    expect(counters.terminalXtermInputReports).toBe(1);
    expect(counters.terminalXtermFitReports).toBe(1);
    expect(counters.maxTerminalXtermAttachMs).toBe(11);
    expect(counters.maxTerminalXtermSnapshotSeedMs).toBe(9);
    expect(counters.maxTerminalXtermOutputMs).toBe(15);
    expect(counters.maxTerminalXtermInputMs).toBe(4);
    expect(counters.maxTerminalXtermFitMs).toBe(21);
    expect(counters.maxTerminalXtermOutputBytes).toBe(20);
    expect(counters.maxTerminalXtermOutputBytesInWindow).toBe(120);
    expect(counters.maxTerminalXtermOutputChunksInWindow).toBe(6);

    resetUiPerfHotPathCounters(counters);

    expect(counters).toEqual(createUiPerfHotPathCounters());
  });
});
