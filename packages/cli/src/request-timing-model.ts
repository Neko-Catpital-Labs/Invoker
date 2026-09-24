export const MUTATION_TIMING_PHASES = [
  'queued',
  'started',
  'completed',
  'failed',
  'evicted',
  'invalidated',
] as const;

export const NAMED_OPERATION_EVENTS = ['start', 'end', 'error'] as const;

export type MutationTimingPhase = (typeof MUTATION_TIMING_PHASES)[number];
export type NamedOperationEvent = (typeof NAMED_OPERATION_EVENTS)[number];

export type MutationTimingRecord = {
  workflowId?: string;
  channel?: string;
  intentId?: number | string;
  function: string;
  phase: MutationTimingPhase;
  at: string | number;
  offsetMs?: number;
  durationMs?: number;
  queueWaitMs?: number;
  traceId?: string;
  bootId?: string;
};

export type NamedOperationTimingRecord = {
  operation: string;
  event: NamedOperationEvent;
  wall_time: string | number;
  monotonic_ms?: number;
  duration_ms?: number;
  intentId?: number | string;
  bootId?: string;
  traceId?: string;
};

export type DiagnosticTimingRecord = Readonly<Record<string, unknown>>;

export type TimingSource = 'mutation' | 'named-operation';

export type TimingEvidence = {
  readonly source: TimingSource;
  readonly recordIndexes: readonly number[];
};

export type UnknownTimingReason =
  | 'no-queued-record'
  | 'negative-queue-sentinel'
  | 'no-completion-record'
  | 'no-start-record'
  | 'clock-discontinuity';

export type TimingValue =
  | { readonly kind: 'measured'; readonly ms: number; readonly evidence: TimingEvidence }
  | { readonly kind: 'unknown'; readonly reason: UnknownTimingReason };

export type TimingInterval = {
  readonly startMs: number;
  readonly endMs: number;
};

export type SpanOutcome =
  | 'completed'
  | 'failed'
  | 'evicted'
  | 'invalidated'
  | 'unterminated'
  | 'unstarted';

export type ExecutionSpan = {
  readonly name: string;
  readonly source: TimingSource;
  readonly outcome: SpanOutcome;
  readonly startedAtMs: number | null;
  readonly endedAtMs: number | null;
  readonly durationMs: TimingValue;
  readonly coverage: TimingInterval | null;
  readonly containedBy: string | null;
  readonly evidence: TimingEvidence;
};

export type TimingObservation = {
  readonly label: string;
  readonly atMs: number;
  readonly recordIndex: number;
  readonly source: TimingSource;
  readonly attributable: false;
};

export type UncoveredInterval = {
  readonly startMs: number;
  readonly endMs: number;
  readonly durationMs: number;
  readonly endsAtObservation: { readonly label: string; readonly atMs: number; readonly recordIndex: number } | null;
  readonly attributedTo: null;
  readonly reason: string;
};

export type ExecutionIdentity = {
  readonly bootId: string | null;
  readonly traceId: string | null;
  readonly confidence: 'certain' | 'uncertain';
  readonly reason: string | null;
};

export type ExecutionTimeline = {
  readonly intentId: number;
  readonly executionIndex: number;
  readonly identity: ExecutionIdentity;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly totalMs: TimingValue;
  readonly queueMs: TimingValue;
  readonly spans: readonly ExecutionSpan[];
  readonly measuredCoverageMs: number;
  readonly uncoveredMs: number;
  readonly uncoveredIntervals: readonly UncoveredInterval[];
  readonly clockDiscontinuity: boolean;
  readonly evidenceLimits: readonly string[];
};

export type IntentTimeline = {
  readonly intentId: number;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly executions: readonly ExecutionTimeline[];
  readonly betweenExecutionIntervals: readonly UncoveredInterval[];
  readonly observations: readonly TimingObservation[];
};

export type IgnoredTimingRecord = {
  readonly index: number;
  readonly reason: 'unrecognized-record-shape' | 'unparseable-timestamp' | 'missing-intent-identity';
};

export type RequestTimingModel = {
  readonly intents: readonly IntentTimeline[];
  readonly ambientObservations: readonly TimingObservation[];
  readonly ignoredRecords: readonly IgnoredTimingRecord[];
  readonly duplicateRecordsDropped: number;
};

export const UNATTRIBUTED_INTERVAL_REASON = 'no measured span covers this interval';

const UNPLACEABLE_COMPLETION_LIMIT = 'a reported duration cannot be placed on the timeline';

type RecordRole = 'queued' | 'open' | 'close';

type NormalizedRecord = {
  readonly index: number;
  readonly source: TimingSource;
  readonly name: string;
  readonly role: RecordRole;
  readonly label: string;
  readonly atMs: number;
  readonly durationMs: number | null;
  readonly queueWaitMs: number | null;
  readonly intentId: number | null;
  readonly bootId: string | null;
  readonly traceId: string | null;
  readonly terminal: 'completed' | 'failed' | 'evicted' | 'invalidated' | null;
};

export function interpretRequestTiming(
  records: readonly DiagnosticTimingRecord[],
): RequestTimingModel {
  const ignoredRecords: IgnoredTimingRecord[] = [];
  const accepted: NormalizedRecord[] = [];
  const seen = new Set<string>();
  let duplicateRecordsDropped = 0;

  records.forEach((record, index) => {
    const classified = classifyRecord(record, index);
    if ('reason' in classified) {
      ignoredRecords.push({ index, reason: classified.reason });
      return;
    }
    const key = identityKey(classified.record);
    if (seen.has(key)) {
      duplicateRecordsDropped += 1;
      return;
    }
    seen.add(key);
    accepted.push(classified.record);
  });

  const ambient = accepted.filter(
    (record) => record.intentId === null && record.source === 'named-operation',
  );
  const byIntent = new Map<number, NormalizedRecord[]>();
  for (const record of accepted) {
    if (record.intentId === null) continue;
    const bucket = byIntent.get(record.intentId);
    if (bucket) bucket.push(record);
    else byIntent.set(record.intentId, [record]);
  }

  const intents = [...byIntent.entries()].map(([intentId, intentRecords]) =>
    buildIntentTimeline(intentId, intentRecords, ambient),
  );

  return {
    intents,
    ambientObservations: ambient.map(toObservation),
    ignoredRecords,
    duplicateRecordsDropped,
  };
}

function classifyRecord(
  record: DiagnosticTimingRecord,
  index: number,
): { record: NormalizedRecord } | { reason: IgnoredTimingRecord['reason'] } {
  const fn = readString(record.function);
  const phase = readString(record.phase);
  const operation = readString(record.operation);
  const event = readString(record.event);

  if (fn && phase && (MUTATION_TIMING_PHASES as readonly string[]).includes(phase)) {
    const atMs = readTimestamp(record.at);
    if (atMs === null) return { reason: 'unparseable-timestamp' };
    const intentId = readIntentId(record.intentId);
    if (intentId === null) return { reason: 'missing-intent-identity' };
    return {
      record: {
        index,
        source: 'mutation',
        name: fn,
        role: mutationRole(phase as MutationTimingPhase),
        label: `${fn}:${phase}`,
        atMs,
        durationMs: readNumber(record.durationMs),
        queueWaitMs: readNumber(record.queueWaitMs),
        intentId,
        bootId: readString(record.bootId),
        traceId: readString(record.traceId),
        terminal: mutationTerminal(phase as MutationTimingPhase),
      },
    };
  }

  if (operation && event && (NAMED_OPERATION_EVENTS as readonly string[]).includes(event)) {
    const atMs = readTimestamp(record.wall_time);
    if (atMs === null) return { reason: 'unparseable-timestamp' };
    return {
      record: {
        index,
        source: 'named-operation',
        name: operation,
        role: event === 'start' ? 'open' : 'close',
        label: `${operation}:${event}`,
        atMs,
        durationMs: readNumber(record.duration_ms),
        queueWaitMs: null,
        intentId: readIntentId(record.intentId),
        bootId: readString(record.bootId),
        traceId: readString(record.traceId),
        terminal: event === 'error' ? 'failed' : event === 'end' ? 'completed' : null,
      },
    };
  }

  return { reason: 'unrecognized-record-shape' };
}

function mutationRole(phase: MutationTimingPhase): RecordRole {
  if (phase === 'queued') return 'queued';
  if (phase === 'started') return 'open';
  return 'close';
}

function mutationTerminal(phase: MutationTimingPhase): NormalizedRecord['terminal'] {
  if (phase === 'completed' || phase === 'failed' || phase === 'evicted' || phase === 'invalidated') {
    return phase;
  }
  return null;
}

function identityKey(record: NormalizedRecord): string {
  return [
    record.source,
    record.name,
    record.label,
    record.atMs,
    record.durationMs,
    record.queueWaitMs,
    record.intentId,
    record.bootId,
    record.traceId,
  ].join('|');
}

function buildIntentTimeline(
  intentId: number,
  records: readonly NormalizedRecord[],
  ambient: readonly NormalizedRecord[],
): IntentTimeline {
  const executions = splitExecutions(records).map((group, position) =>
    buildExecution(intentId, group, position + 1, ambient),
  );
  const startedAtMs = Math.min(...records.map((record) => record.atMs));
  const endedAtMs = Math.max(...records.map((record) => record.atMs));
  const observations = ambient
    .filter((record) => record.atMs >= startedAtMs && record.atMs <= endedAtMs)
    .map(toObservation);

  const betweenExecutionIntervals: UncoveredInterval[] = [];
  for (let index = 1; index < executions.length; index += 1) {
    const previous = executions[index - 1]!;
    const next = executions[index]!;
    if (next.startedAtMs <= previous.endedAtMs) continue;
    betweenExecutionIntervals.push(
      ...describeUncovered(
        [{ startMs: previous.endedAtMs, endMs: next.startedAtMs }],
        observations,
      ),
    );
  }

  return { intentId, startedAtMs, endedAtMs, executions, betweenExecutionIntervals, observations };
}

function splitExecutions(records: readonly NormalizedRecord[]): NormalizedRecord[][] {
  const groups: NormalizedRecord[][] = [];
  let current: NormalizedRecord[] | null = null;
  let bootId: string | null = null;
  let traceId: string | null = null;
  let openSpans = new Map<string, number>();
  let openedAny = false;

  for (const record of records) {
    const identityChanged =
      current !== null &&
      ((bootId !== null && record.bootId !== null && record.bootId !== bootId) ||
        (traceId !== null && record.traceId !== null && record.traceId !== traceId));
    const restarted =
      current !== null && openedAny && openSpans.size === 0 && record.role !== 'close';

    if (current === null || identityChanged || restarted) {
      current = [];
      groups.push(current);
      bootId = null;
      traceId = null;
      openSpans = new Map();
      openedAny = false;
    }

    current.push(record);
    if (bootId === null) bootId = record.bootId;
    if (traceId === null) traceId = record.traceId;
    if (record.role === 'open') {
      openSpans.set(record.name, (openSpans.get(record.name) ?? 0) + 1);
      openedAny = true;
    } else if (record.role === 'close') {
      const open = openSpans.get(record.name) ?? 0;
      if (open > 1) openSpans.set(record.name, open - 1);
      else openSpans.delete(record.name);
    }
  }

  return groups;
}

function buildExecution(
  intentId: number,
  records: readonly NormalizedRecord[],
  executionIndex: number,
  ambient: readonly NormalizedRecord[],
): ExecutionTimeline {
  const evidenceLimits: string[] = [];
  const spans: ExecutionSpan[] = [];
  const unplaceable: NormalizedRecord[] = [];
  const pending = new Map<string, NormalizedRecord[]>();
  let clockDiscontinuity = false;

  for (let index = 1; index < records.length; index += 1) {
    if (records[index]!.atMs < records[index - 1]!.atMs) clockDiscontinuity = true;
  }

  for (const record of records) {
    if (record.role === 'open') {
      const stack = pending.get(record.name);
      if (stack) stack.push(record);
      else pending.set(record.name, [record]);
      continue;
    }
    if (record.role !== 'close') continue;

    const opened = pending.get(record.name)?.pop();
    if (!opened) {
      spans.push(unstartedSpan(record));
      unplaceable.push(record);
      evidenceLimits.push(
        `${record.label} completion has no measured start; ${UNPLACEABLE_COMPLETION_LIMIT}`,
      );
      continue;
    }

    const wallMs = record.atMs - opened.atMs;
    if (wallMs < 0) clockDiscontinuity = true;
    if (record.durationMs !== null && wallMs >= 0 && Math.abs(record.durationMs - wallMs) > 1) {
      evidenceLimits.push(
        `${record.name} reported duration ${record.durationMs}ms disagrees with wall-clock ${wallMs}ms`,
      );
    }
    spans.push(pairedSpan(opened, record, wallMs));
  }

  for (const stack of pending.values()) {
    for (const opened of stack) {
      spans.push(unterminatedSpan(opened));
      evidenceLimits.push(`${opened.name} started with no completion record`);
    }
  }

  spans.sort(compareSpans);

  const queue = resolveQueue(records);
  const startedAtMs = Math.min(...records.map((record) => record.atMs));
  const endedAtMs = Math.max(...records.map((record) => record.atMs));
  const coverage = mergeIntervals([
    ...(queue.coverage ? [queue.coverage] : []),
    ...spans.flatMap((span) => (span.coverage ? [span.coverage] : [])),
  ]);
  const measuredCoverageMs = coverage.reduce(
    (total, interval) => total + (interval.endMs - interval.startMs),
    0,
  );
  const observations = [
    ...unplaceable,
    ...ambient.filter((record) => record.atMs >= startedAtMs && record.atMs <= endedAtMs),
  ]
    .sort((left, right) => left.atMs - right.atMs || left.index - right.index)
    .map(toObservation);
  const uncoveredIntervals = describeUncovered(
    complementIntervals({ startMs: startedAtMs, endMs: endedAtMs }, coverage),
    observations,
  );

  return {
    intentId,
    executionIndex,
    identity: resolveIdentity(records),
    startedAtMs,
    endedAtMs,
    totalMs: {
      kind: 'measured',
      ms: endedAtMs - startedAtMs,
      evidence: {
        source: records[0]!.source,
        recordIndexes: [
          boundaryIndex(records, startedAtMs, 'first'),
          boundaryIndex(records, endedAtMs, 'last'),
        ],
      },
    },
    queueMs: queue.value,
    spans: withContainment(spans),
    measuredCoverageMs,
    uncoveredMs: uncoveredIntervals.reduce((total, interval) => total + interval.durationMs, 0),
    uncoveredIntervals,
    clockDiscontinuity,
    evidenceLimits,
  };
}

function pairedSpan(
  opened: NormalizedRecord,
  closed: NormalizedRecord,
  wallMs: number,
): ExecutionSpan {
  const evidence: TimingEvidence = {
    source: opened.source,
    recordIndexes: [opened.index, closed.index],
  };
  const placeable = wallMs >= 0;
  return {
    name: opened.name,
    source: opened.source,
    outcome: closed.terminal ?? 'completed',
    startedAtMs: opened.atMs,
    endedAtMs: closed.atMs,
    durationMs: placeable
      ? { kind: 'measured', ms: closed.durationMs ?? wallMs, evidence }
      : { kind: 'unknown', reason: 'clock-discontinuity' },
    coverage: placeable ? { startMs: opened.atMs, endMs: closed.atMs } : null,
    containedBy: null,
    evidence,
  };
}

function unstartedSpan(closed: NormalizedRecord): ExecutionSpan {
  const evidence: TimingEvidence = { source: closed.source, recordIndexes: [closed.index] };
  return {
    name: closed.name,
    source: closed.source,
    outcome: 'unstarted',
    startedAtMs: null,
    endedAtMs: closed.atMs,
    durationMs:
      closed.durationMs !== null
        ? { kind: 'measured', ms: closed.durationMs, evidence }
        : { kind: 'unknown', reason: 'no-start-record' },
    coverage: null,
    containedBy: null,
    evidence,
  };
}

function unterminatedSpan(opened: NormalizedRecord): ExecutionSpan {
  return {
    name: opened.name,
    source: opened.source,
    outcome: 'unterminated',
    startedAtMs: opened.atMs,
    endedAtMs: null,
    durationMs: { kind: 'unknown', reason: 'no-completion-record' },
    coverage: null,
    containedBy: null,
    evidence: { source: opened.source, recordIndexes: [opened.index] },
  };
}

function compareSpans(left: ExecutionSpan, right: ExecutionSpan): number {
  const leftAt = left.startedAtMs ?? left.endedAtMs ?? 0;
  const rightAt = right.startedAtMs ?? right.endedAtMs ?? 0;
  if (leftAt !== rightAt) return leftAt - rightAt;
  return left.evidence.recordIndexes[0]! - right.evidence.recordIndexes[0]!;
}

function withContainment(spans: readonly ExecutionSpan[]): ExecutionSpan[] {
  return spans.map((span) => {
    if (!span.coverage) return span;
    let container: ExecutionSpan | null = null;
    for (const candidate of spans) {
      if (candidate === span || !candidate.coverage) continue;
      if (candidate.coverage.startMs > span.coverage.startMs) continue;
      if (candidate.coverage.endMs < span.coverage.endMs) continue;
      const candidateWidth = candidate.coverage.endMs - candidate.coverage.startMs;
      const spanWidth = span.coverage.endMs - span.coverage.startMs;
      if (candidateWidth === spanWidth) continue;
      if (!container || candidateWidth < container.coverage!.endMs - container.coverage!.startMs) {
        container = candidate;
      }
    }
    return { ...span, containedBy: container ? container.name : null };
  });
}

function resolveQueue(records: readonly NormalizedRecord[]): {
  value: TimingValue;
  coverage: TimingInterval | null;
} {
  const queuedPosition = records.findIndex((record) => record.role === 'queued');
  if (queuedPosition >= 0) {
    const queued = records[queuedPosition]!;
    const started = records
      .slice(queuedPosition + 1)
      .find((record) => record.role === 'open' && record.name === queued.name);
    if (started) {
      const waitMs = started.atMs - queued.atMs;
      const evidence: TimingEvidence = {
        source: queued.source,
        recordIndexes: [queued.index, started.index],
      };
      if (waitMs < 0) return { value: { kind: 'unknown', reason: 'clock-discontinuity' }, coverage: null };
      return {
        value: { kind: 'measured', ms: waitMs, evidence },
        coverage: { startMs: queued.atMs, endMs: started.atMs },
      };
    }
  }

  const reported = records.find((record) => record.queueWaitMs !== null);
  if (reported) {
    if (reported.queueWaitMs! < 0) {
      return { value: { kind: 'unknown', reason: 'negative-queue-sentinel' }, coverage: null };
    }
    return {
      value: {
        kind: 'measured',
        ms: reported.queueWaitMs!,
        evidence: { source: reported.source, recordIndexes: [reported.index] },
      },
      coverage: null,
    };
  }

  return { value: { kind: 'unknown', reason: 'no-queued-record' }, coverage: null };
}

function resolveIdentity(records: readonly NormalizedRecord[]): ExecutionIdentity {
  const bootId = records.find((record) => record.bootId !== null)?.bootId ?? null;
  const traceId = records.find((record) => record.traceId !== null)?.traceId ?? null;
  if (bootId !== null) return { bootId, traceId, confidence: 'certain', reason: null };
  if (traceId !== null) {
    return {
      bootId,
      traceId,
      confidence: 'uncertain',
      reason: 'no boot identity; executions separated by trace identity only',
    };
  }
  return {
    bootId,
    traceId,
    confidence: 'uncertain',
    reason: 'no boot or trace identity; executions separated by span structure only',
  };
}

function toObservation(record: NormalizedRecord): TimingObservation {
  return {
    label: record.label,
    atMs: record.atMs,
    recordIndex: record.index,
    source: record.source,
    attributable: false,
  };
}

function boundaryIndex(
  records: readonly NormalizedRecord[],
  atMs: number,
  edge: 'first' | 'last',
): number {
  const matching = records.filter((record) => record.atMs === atMs);
  return (edge === 'first' ? matching[0]! : matching[matching.length - 1]!).index;
}

function mergeIntervals(intervals: readonly TimingInterval[]): TimingInterval[] {
  const sorted = [...intervals]
    .filter((interval) => interval.endMs > interval.startMs)
    .sort((left, right) => left.startMs - right.startMs);
  const merged: TimingInterval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.startMs <= last.endMs) {
      if (interval.endMs > last.endMs) merged[merged.length - 1] = { startMs: last.startMs, endMs: interval.endMs };
      continue;
    }
    merged.push(interval);
  }
  return merged;
}

function complementIntervals(
  window: TimingInterval,
  covered: readonly TimingInterval[],
): TimingInterval[] {
  const gaps: TimingInterval[] = [];
  let cursor = window.startMs;
  for (const interval of covered) {
    if (interval.startMs > cursor) gaps.push({ startMs: cursor, endMs: Math.min(interval.startMs, window.endMs) });
    cursor = Math.max(cursor, interval.endMs);
    if (cursor >= window.endMs) break;
  }
  if (cursor < window.endMs) gaps.push({ startMs: cursor, endMs: window.endMs });
  return gaps.filter((gap) => gap.endMs > gap.startMs);
}

function describeUncovered(
  gaps: readonly TimingInterval[],
  observations: readonly TimingObservation[],
): UncoveredInterval[] {
  const described: UncoveredInterval[] = [];
  for (const gap of gaps) {
    const splitPoints = observations
      .filter((observation) => observation.atMs > gap.startMs && observation.atMs < gap.endMs)
      .map((observation) => observation.atMs)
      .sort((left, right) => left - right);
    let cursor = gap.startMs;
    for (const point of [...new Set(splitPoints), gap.endMs]) {
      if (point <= cursor) continue;
      described.push({
        startMs: cursor,
        endMs: point,
        durationMs: point - cursor,
        endsAtObservation:
          observations
            .filter((observation) => observation.atMs === point)
            .map((observation) => ({
              label: observation.label,
              atMs: observation.atMs,
              recordIndex: observation.recordIndex,
            }))[0] ?? null,
        attributedTo: null,
        reason: UNATTRIBUTED_INTERVAL_REASON,
      });
      cursor = point;
    }
  }
  return described;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readIntentId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function readTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
