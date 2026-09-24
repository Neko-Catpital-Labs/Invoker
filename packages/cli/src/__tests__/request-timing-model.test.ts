import { describe, expect, it } from 'vitest';

import {
  interpretRequestTiming,
  UNATTRIBUTED_INTERVAL_REASON,
  type DiagnosticTimingRecord,
  type ExecutionTimeline,
  type TimingValue,
} from '../request-timing-model.js';

const T0 = Date.parse('2026-09-20T04:00:00.000Z');

function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

function mutation(
  offsetMs: number,
  fn: string,
  phase: string,
  extra: Record<string, unknown> = {},
): DiagnosticTimingRecord {
  return {
    workflowId: 'wf-do1',
    channel: 'retry-task',
    intentId: 43681,
    function: fn,
    phase,
    at: at(offsetMs),
    ...extra,
  };
}

const BOOT_ONE = { bootId: 'owner-boot-1c9', traceId: 'trace-43681-a' };
const BOOT_TWO = { bootId: 'owner-boot-4e2', traceId: 'trace-43681-b' };

function do1Records(): DiagnosticTimingRecord[] {
  return [
    mutation(0, 'dispatch', 'queued', BOOT_ONE),
    mutation(15, 'dispatch', 'started', BOOT_ONE),
    mutation(12531, 'retryTask', 'started', BOOT_ONE),
    mutation(178481, 'retryTask', 'completed', { ...BOOT_ONE, durationMs: 165950 }),
    mutation(178481, 'retryTask', 'completed', { ...BOOT_ONE, durationMs: 165950 }),
    mutation(178481, 'dispatch', 'completed', { ...BOOT_ONE, durationMs: 178466 }),
    mutation(178588, 'settleIntent', 'completed', BOOT_ONE),
    { operation: 'db-reaper-pass', event: 'end', wall_time: at(312145), monotonic_ms: 9312145 },
    mutation(312157, 'dispatch', 'started', { ...BOOT_TWO, queueWaitMs: -1 }),
    mutation(320000, 'retryTask', 'started', BOOT_TWO),
    mutation(348879, 'retryTask', 'completed', { ...BOOT_TWO, durationMs: 28879 }),
    mutation(353264, 'dispatch', 'completed', { ...BOOT_TWO, durationMs: 41107 }),
    mutation(353401, 'settleIntent', 'completed', BOOT_TWO),
  ];
}

function ms(value: TimingValue): number | string {
  return value.kind === 'measured' ? value.ms : `unknown:${value.reason}`;
}

function spanMs(execution: ExecutionTimeline, name: string): number | string {
  const span = execution.spans.find((candidate) => candidate.name === name);
  if (!span) return 'absent';
  return ms(span.durationMs);
}

function summarize(execution: ExecutionTimeline): Record<string, number | string> {
  return {
    queueMs: ms(execution.queueMs),
    retryTaskMs: spanMs(execution, 'retryTask'),
    dispatchMs: spanMs(execution, 'dispatch'),
    totalMs: ms(execution.totalMs),
  };
}

describe('interpretRequestTiming DO1 intent 43681 acceptance', () => {
  it('preserves both executions of intent 43681 exactly as recorded', () => {
    const model = interpretRequestTiming(do1Records());

    expect(model.intents).toHaveLength(1);
    const timeline = model.intents[0]!;
    expect(timeline.intentId).toBe(43681);
    expect(timeline.executions).toHaveLength(2);

    expect(summarize(timeline.executions[0]!)).toEqual({
      queueMs: 15,
      retryTaskMs: 165950,
      dispatchMs: 178466,
      totalMs: 178588,
    });

    expect(summarize(timeline.executions[1]!)).toEqual({
      queueMs: 'unknown:negative-queue-sentinel',
      retryTaskMs: 28879,
      dispatchMs: 41107,
      totalMs: 41244,
    });
  });

  it('separates the two executions by boot identity', () => {
    const [first, second] = interpretRequestTiming(do1Records()).intents[0]!.executions;

    expect(first!.executionIndex).toBe(1);
    expect(first!.identity).toEqual({
      bootId: 'owner-boot-1c9',
      traceId: 'trace-43681-a',
      confidence: 'certain',
      reason: null,
    });
    expect(second!.executionIndex).toBe(2);
    expect(second!.identity.bootId).toBe('owner-boot-4e2');
    expect(second!.identity.confidence).toBe('certain');
  });

  it('never double counts the nested retryTask span inside dispatch', () => {
    const first = interpretRequestTiming(do1Records()).intents[0]!.executions[0]!;

    const naiveSum = first.spans.reduce(
      (total, span) => total + (span.durationMs.kind === 'measured' ? span.durationMs.ms : 0),
      0,
    );
    expect(naiveSum).toBe(344416);
    expect(first.measuredCoverageMs).toBe(178481);
    expect(first.uncoveredMs).toBe(107);

    const retryTask = first.spans.find((span) => span.name === 'retryTask')!;
    const dispatch = first.spans.find((span) => span.name === 'dispatch')!;
    expect(retryTask.containedBy).toBe('dispatch');
    expect(dispatch.containedBy).toBeNull();
  });

  it('leaves the 133557ms interval ending at reaper completion unattributed', () => {
    const timeline = interpretRequestTiming(do1Records()).intents[0]!;

    expect(
      timeline.betweenExecutionIntervals.map((interval) => ({
        durationMs: interval.durationMs,
        endsAtObservation: interval.endsAtObservation?.label ?? null,
        attributedTo: interval.attributedTo,
        reason: interval.reason,
      })),
    ).toEqual([
      {
        durationMs: 133557,
        endsAtObservation: 'db-reaper-pass:end',
        attributedTo: null,
        reason: UNATTRIBUTED_INTERVAL_REASON,
      },
      {
        durationMs: 12,
        endsAtObservation: null,
        attributedTo: null,
        reason: UNATTRIBUTED_INTERVAL_REASON,
      },
    ]);

    expect(timeline.observations).toEqual([
      {
        label: 'db-reaper-pass:end',
        atMs: T0 + 312145,
        recordIndex: 7,
        source: 'named-operation',
        attributable: false,
      },
    ]);
  });

  it('reports the uncovered tail of each execution without inventing a span', () => {
    const [first, second] = interpretRequestTiming(do1Records()).intents[0]!.executions;

    expect(first!.uncoveredIntervals).toEqual([
      {
        startMs: T0 + 178481,
        endMs: T0 + 178588,
        durationMs: 107,
        endsAtObservation: { label: 'settleIntent:completed', atMs: T0 + 178588, recordIndex: 6 },
        attributedTo: null,
        reason: UNATTRIBUTED_INTERVAL_REASON,
      },
    ]);
    expect(second!.uncoveredIntervals.map((interval) => interval.durationMs)).toEqual([137]);
    expect(second!.measuredCoverageMs).toBe(41107);
  });

  it('drops the duplicated retryTask completion and keeps first-seen provenance', () => {
    const model = interpretRequestTiming(do1Records());
    const first = model.intents[0]!.executions[0]!;
    const retryTask = first.spans.find((span) => span.name === 'retryTask')!;

    expect(model.duplicateRecordsDropped).toBe(1);
    expect(retryTask.evidence).toEqual({ source: 'mutation', recordIndexes: [2, 3] });
    expect(first.queueMs).toEqual({
      kind: 'measured',
      ms: 15,
      evidence: { source: 'mutation', recordIndexes: [0, 1] },
    });
  });
});

describe('interpretRequestTiming evidence limits', () => {
  it('treats a background completion as an observation, never as coverage', () => {
    const model = interpretRequestTiming([
      mutation(0, 'dispatch', 'started', BOOT_ONE),
      { operation: 'wal_checkpoint', event: 'end', wall_time: at(4000), duration_ms: 900, intentId: 43681 },
      mutation(9000, 'dispatch', 'completed', { ...BOOT_ONE, durationMs: 9000 }),
    ]);
    const execution = model.intents[0]!.executions[0]!;
    const checkpoint = execution.spans.find((span) => span.name === 'wal_checkpoint')!;

    expect(checkpoint.outcome).toBe('unstarted');
    expect(checkpoint.coverage).toBeNull();
    expect(checkpoint.durationMs).toEqual({
      kind: 'measured',
      ms: 900,
      evidence: { source: 'named-operation', recordIndexes: [1] },
    });
    expect(execution.measuredCoverageMs).toBe(9000);
    expect(execution.evidenceLimits).toContain(
      'wal_checkpoint:end completion has no measured start; a reported duration cannot be placed on the timeline',
    );
  });

  it('keeps one execution when an unmatched background completion lands mid-span', () => {
    const model = interpretRequestTiming([
      mutation(0, 'dispatch', 'started', BOOT_ONE),
      { operation: 'wal_checkpoint', event: 'end', wall_time: at(4000), intentId: 43681 },
      mutation(5000, 'retryTask', 'started', BOOT_ONE),
      mutation(8000, 'retryTask', 'completed', { ...BOOT_ONE, durationMs: 3000 }),
      mutation(9000, 'dispatch', 'completed', { ...BOOT_ONE, durationMs: 9000 }),
    ]);
    const executions = model.intents[0]!.executions;

    expect(executions).toHaveLength(1);
    expect(spanMs(executions[0]!, 'dispatch')).toBe(9000);
    expect(executions[0]!.spans.find((span) => span.name === 'retryTask')!.containedBy).toBe('dispatch');
  });

  it('reports an unstarted completion without a duration as missing its start', () => {
    const model = interpretRequestTiming([
      mutation(0, 'dispatch', 'started', BOOT_ONE),
      { operation: 'wal_checkpoint', event: 'end', wall_time: at(4000), intentId: 43681 },
      mutation(9000, 'dispatch', 'completed', { ...BOOT_ONE, durationMs: 9000 }),
    ]);
    const checkpoint = model.intents[0]!.executions[0]!.spans.find(
      (span) => span.name === 'wal_checkpoint',
    )!;

    expect(checkpoint.outcome).toBe('unstarted');
    expect(checkpoint.durationMs).toEqual({ kind: 'unknown', reason: 'no-start-record' });
  });

  it('reports an unterminated span as unknown rather than guessing an end', () => {
    const model = interpretRequestTiming([
      mutation(0, 'dispatch', 'started', BOOT_ONE),
      mutation(500, 'retryTask', 'started', BOOT_ONE),
      mutation(20000, 'dispatch', 'completed', { ...BOOT_ONE, durationMs: 20000 }),
    ]);
    const execution = model.intents[0]!.executions[0]!;
    const retryTask = execution.spans.find((span) => span.name === 'retryTask')!;

    expect(retryTask.outcome).toBe('unterminated');
    expect(retryTask.durationMs).toEqual({ kind: 'unknown', reason: 'no-completion-record' });
    expect(retryTask.coverage).toBeNull();
    expect(execution.evidenceLimits).toContain('retryTask started with no completion record');
  });

  it('refuses to emit a negative duration when the clock moves backwards', () => {
    const model = interpretRequestTiming([
      mutation(0, 'dispatch', 'queued', BOOT_ONE),
      mutation(10, 'dispatch', 'started', BOOT_ONE),
      mutation(9, 'retryTask', 'started', BOOT_ONE),
      mutation(5, 'retryTask', 'completed', BOOT_ONE),
      mutation(4000, 'dispatch', 'completed', { ...BOOT_ONE, durationMs: 3990 }),
    ]);
    const execution = model.intents[0]!.executions[0]!;
    const retryTask = execution.spans.find((span) => span.name === 'retryTask')!;

    expect(execution.clockDiscontinuity).toBe(true);
    expect(retryTask.durationMs).toEqual({ kind: 'unknown', reason: 'clock-discontinuity' });
    expect(retryTask.coverage).toBeNull();
    expect(execution.measuredCoverageMs).toBe(3990 + 10);
  });

  it('flags a reported duration that disagrees with the wall clock', () => {
    const model = interpretRequestTiming([
      mutation(0, 'dispatch', 'started', BOOT_ONE),
      mutation(1000, 'dispatch', 'completed', { ...BOOT_ONE, durationMs: 400 }),
    ]);
    const execution = model.intents[0]!.executions[0]!;

    expect(spanMs(execution, 'dispatch')).toBe(400);
    expect(execution.measuredCoverageMs).toBe(1000);
    expect(execution.evidenceLimits).toContain(
      'dispatch reported duration 400ms disagrees with wall-clock 1000ms',
    );
  });

  it('marks legacy records with no boot or trace identity as uncertain', () => {
    const model = interpretRequestTiming([
      mutation(0, 'dispatch', 'started'),
      mutation(700, 'dispatch', 'completed', { durationMs: 700 }),
      mutation(900, 'dispatch', 'started'),
      mutation(1500, 'dispatch', 'completed', { durationMs: 600 }),
    ]);
    const timeline = model.intents[0]!;

    expect(timeline.executions).toHaveLength(2);
    expect(timeline.executions[0]!.identity).toEqual({
      bootId: null,
      traceId: null,
      confidence: 'uncertain',
      reason: 'no boot or trace identity; executions separated by span structure only',
    });
    expect(timeline.executions[1]!.queueMs).toEqual({ kind: 'unknown', reason: 'no-queued-record' });
  });

  it('ignores records it cannot recognise or place, with a reason each', () => {
    const model = interpretRequestTiming([
      mutation(0, 'dispatch', 'started', BOOT_ONE),
      mutation(10, 'dispatch', 'completed', { ...BOOT_ONE, durationMs: 10 }),
      { function: 'dispatch', phase: 'started', at: 'not-a-timestamp', intentId: 43681 },
      { function: 'dispatch', phase: 'started', at: at(20) },
      { message: 'unrelated log line' },
    ]);

    expect(model.ignoredRecords).toEqual([
      { index: 2, reason: 'unparseable-timestamp' },
      { index: 3, reason: 'missing-intent-identity' },
      { index: 4, reason: 'unrecognized-record-shape' },
    ]);
    expect(model.intents[0]!.executions).toHaveLength(1);
  });

  it('unions partially overlapping sibling spans instead of summing them', () => {
    const model = interpretRequestTiming([
      mutation(0, 'dispatch', 'started', BOOT_ONE),
      mutation(100, 'fetchRepo', 'started', BOOT_ONE),
      mutation(400, 'pushBranch', 'started', BOOT_ONE),
      mutation(600, 'fetchRepo', 'completed', { ...BOOT_ONE, durationMs: 500 }),
      mutation(900, 'pushBranch', 'completed', { ...BOOT_ONE, durationMs: 500 }),
      mutation(1000, 'dispatch', 'completed', { ...BOOT_ONE, durationMs: 1000 }),
    ]);
    const execution = model.intents[0]!.executions[0]!;

    expect(execution.measuredCoverageMs).toBe(1000);
    expect(execution.uncoveredIntervals).toEqual([]);
    expect(execution.spans.find((span) => span.name === 'pushBranch')!.containedBy).toBe('dispatch');
  });

  it('splits an uncovered interval at an ambient observation without attributing it', () => {
    const model = interpretRequestTiming([
      mutation(0, 'dispatch', 'started', BOOT_ONE),
      mutation(1000, 'dispatch', 'completed', { ...BOOT_ONE, durationMs: 1000 }),
      { operation: 'db-reaper-pass', event: 'end', wall_time: at(3000) },
      mutation(5000, 'settleIntent', 'completed', BOOT_ONE),
    ]);
    const execution = model.intents[0]!.executions[0]!;

    expect(
      execution.uncoveredIntervals.map((interval) => ({
        durationMs: interval.durationMs,
        endsAtObservation: interval.endsAtObservation?.label ?? null,
        attributedTo: interval.attributedTo,
      })),
    ).toEqual([
      { durationMs: 2000, endsAtObservation: 'db-reaper-pass:end', attributedTo: null },
      { durationMs: 2000, endsAtObservation: 'settleIntent:completed', attributedTo: null },
    ]);
    expect(execution.uncoveredMs).toBe(4000);
  });
})
