import { describe, it, expect, vi } from 'vitest';
import {
  createRendererHotPathUiPerfCounters,
  createTerminalUiPerfCounters,
  createTerminalUiPerfReporter,
  createTerminalUiPerfSink,
  recordRendererHotPathUiPerfMetric,
  resetRendererHotPathUiPerfCounters,
  timeTerminalWrite,
  TERMINAL_SESSION_UPSERT_SLOW_MS,
  TERMINAL_WRITE_SLOW_MS,
} from '../terminal-ui-perf.js';

describe('createTerminalUiPerfReporter', () => {
  it('emits terminal_write_slow when write duration crosses the threshold', () => {
    const writeActivityLog = vi.fn();
    const onSlowMetric = vi.fn();
    const reporter = createTerminalUiPerfReporter({
      throttleMs: 0,
      now: () => 1_000,
    });

    reporter.recordWrite(TERMINAL_WRITE_SLOW_MS - 1, { sessionId: 's1' }, { writeActivityLog, onSlowMetric });
    expect(writeActivityLog).not.toHaveBeenCalled();

    reporter.recordWrite(TERMINAL_WRITE_SLOW_MS, { sessionId: 's1', bytes: 1 }, { writeActivityLog, onSlowMetric });
    expect(writeActivityLog).toHaveBeenCalledTimes(1);
    const [, , message] = writeActivityLog.mock.calls[0]!;
    const payload = JSON.parse(message as string) as Record<string, unknown>;
    expect(payload.metric).toBe('terminal_write_slow');
    expect(payload.durationMs).toBe(TERMINAL_WRITE_SLOW_MS);
    expect(payload.sessionId).toBe('s1');
    expect(onSlowMetric).toHaveBeenCalledWith(
      'terminal_write_slow',
      expect.objectContaining({ durationMs: TERMINAL_WRITE_SLOW_MS, sessionId: 's1' }),
    );
  });

  it('emits terminal_session_upsert_slow for slow upserts and for burst frequency', () => {
    let now = 0;
    const writeActivityLog = vi.fn();
    const reporter = createTerminalUiPerfReporter({
      throttleMs: 0,
      upsertBurstCount: 3,
      upsertBurstWindowMs: 1000,
      now: () => now,
    });

    reporter.recordUpsert(TERMINAL_SESSION_UPSERT_SLOW_MS, { sessionId: 's1' }, { writeActivityLog });
    expect(writeActivityLog).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writeActivityLog.mock.calls[0]![2] as string).metric).toBe('terminal_session_upsert_slow');
    expect(JSON.parse(writeActivityLog.mock.calls[0]![2] as string).slow).toBe(true);

    writeActivityLog.mockClear();
    now = 10;
    reporter.recordUpsert(1, { sessionId: 's1' }, { writeActivityLog });
    reporter.recordUpsert(1, { sessionId: 's1' }, { writeActivityLog });
    expect(writeActivityLog).not.toHaveBeenCalled();
    reporter.recordUpsert(1, { sessionId: 's1' }, { writeActivityLog });
    expect(writeActivityLog).toHaveBeenCalledTimes(1);
    const burstPayload = JSON.parse(writeActivityLog.mock.calls[0]![2] as string) as Record<string, unknown>;
    expect(burstPayload.metric).toBe('terminal_session_upsert_slow');
    expect(burstPayload.burst).toBe(true);
    expect(burstPayload.upsertsInWindow).toBe(3);
  });

  it('throttles repeated slow metrics within the throttle window', () => {
    let now = 1000;
    const writeActivityLog = vi.fn();
    const reporter = createTerminalUiPerfReporter({
      throttleMs: 1000,
      now: () => now,
    });

    reporter.recordWrite(100, { sessionId: 's1' }, { writeActivityLog });
    reporter.recordWrite(120, { sessionId: 's1' }, { writeActivityLog });
    expect(writeActivityLog).toHaveBeenCalledTimes(1);

    now = 2000;
    reporter.recordWrite(130, { sessionId: 's1' }, { writeActivityLog });
    expect(writeActivityLog).toHaveBeenCalledTimes(2);
  });

  it('timeTerminalWrite updates counters and reports slow writes', () => {
    const counters = createTerminalUiPerfCounters();
    const writeActivityLog = vi.fn();
    const sink = createTerminalUiPerfSink(writeActivityLog, counters);
    const reporter = createTerminalUiPerfReporter({
      writeSlowMs: 0,
      throttleMs: 0,
      now: () => 1_000,
    });

    const result = timeTerminalWrite(
      () => ({ ok: true as const }),
      counters,
      reporter,
      sink,
      { sessionId: 's1', bytes: 2 },
    );

    expect(result).toEqual({ ok: true });
    expect(counters.maxTerminalWriteMs).toBeGreaterThanOrEqual(0);
    expect(writeActivityLog).toHaveBeenCalledTimes(1);
    expect(counters.terminalWriteSlowCount).toBe(1);
  });
});

describe('recordRendererHotPathUiPerfMetric', () => {
  it('rolls up planning chat input and transcript render markers', () => {
    const counters = createRendererHotPathUiPerfCounters();

    expect(recordRendererHotPathUiPerfMetric(counters, 'planning_chat_input_commit', {
      durationMs: 42,
      renderDurationMs: 17,
    })).toBe(true);
    expect(recordRendererHotPathUiPerfMetric(counters, 'planning_chat_transcript_render', {
      durationMs: 9,
      lineCount: 12,
      transcriptTextChars: 2048,
    })).toBe(true);

    expect(counters.planningChatInputCommitCount).toBe(1);
    expect(counters.maxPlanningChatInputCommitMs).toBe(42);
    expect(counters.maxPlanningChatInputRenderMs).toBe(17);
    expect(counters.planningChatTranscriptRenderCount).toBe(1);
    expect(counters.maxPlanningChatTranscriptRenderMs).toBe(9);
    expect(counters.maxPlanningChatTranscriptLineCount).toBe(12);
    expect(counters.maxPlanningChatTranscriptChars).toBe(2048);
  });

  it('rolls up renderer terminal attach, snapshot seed, and output pressure markers', () => {
    const counters = createRendererHotPathUiPerfCounters();

    expect(recordRendererHotPathUiPerfMetric(counters, 'terminal_renderer_attach', {
      durationMs: 31,
    })).toBe(true);
    expect(recordRendererHotPathUiPerfMetric(counters, 'terminal_renderer_snapshot_seed', {
      durationMs: 13,
    })).toBe(true);
    expect(recordRendererHotPathUiPerfMetric(counters, 'terminal_renderer_output_write', {
      durationMs: 7,
      maxWriteMsInWindow: 19,
      chars: 80,
      chunksInWindow: 24,
      charsInWindow: 65536,
      burst: true,
    })).toBe(true);
    expect(recordRendererHotPathUiPerfMetric(counters, 'unrelated_metric', {})).toBe(false);

    expect(counters.terminalRendererAttachCount).toBe(1);
    expect(counters.maxTerminalRendererAttachMs).toBe(31);
    expect(counters.terminalRendererSnapshotSeedCount).toBe(1);
    expect(counters.maxTerminalRendererSnapshotSeedMs).toBe(13);
    expect(counters.terminalRendererOutputWriteReports).toBe(1);
    expect(counters.terminalRendererOutputBurstReports).toBe(1);
    expect(counters.maxTerminalRendererOutputWriteMs).toBe(19);
    expect(counters.maxTerminalRendererOutputChars).toBe(80);
    expect(counters.maxTerminalRendererOutputChunksInWindow).toBe(24);
    expect(counters.maxTerminalRendererOutputCharsInWindow).toBe(65536);

    resetRendererHotPathUiPerfCounters(counters);
    expect(counters.planningChatInputCommitCount).toBe(0);
    expect(counters.terminalRendererOutputBurstReports).toBe(0);
    expect(counters.maxTerminalRendererOutputCharsInWindow).toBe(0);
  });
});
