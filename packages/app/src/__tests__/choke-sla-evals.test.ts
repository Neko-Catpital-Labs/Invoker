import { describe, expect, it } from 'vitest';
import { WORKFLOW_MUTATION_LEASE_MS } from '@invoker/data-store';

import {
  ChokeBoundaryMetrics,
  type ChokeBoundaryQueueName,
} from '../choke-boundary-metrics.js';

type QueueOutcome = 'accepted' | 'rejected';

type SlaBudget =
  | {
    kind: 'max';
    maxMs: number;
    docBudget: string;
  }
  | {
    kind: 'p95-and-max';
    p95Ms: number;
    maxMs: number;
    docBudget: string;
  }
  | {
    kind: 'under';
    maxMs: number;
    docBudget: string;
  }
  | {
    kind: 'poll-intervals';
    intervalMs: number;
    intervals: number;
    docBudget: string;
  };

type SlaBurstFixture = {
  name: string;
  completeness: string;
  samplesMs: readonly number[];
  budget: SlaBudget;
  queue?: {
    name: ChokeBoundaryQueueName;
    outcomes: readonly QueueOutcome[];
  };
};

const UI_ACK_BUDGET_MS = 200;
const WORKFLOW_SELECTION_VISIBLE_BUDGET_MS = 100;
const CHEAP_IPC_P95_BUDGET_MS = 200;
const CHEAP_IPC_MAX_BUDGET_MS = 250;
const PR_QUALITY_JOB_BUDGET_MS = 5 * 60 * 1000;
const STANDALONE_LAUNCH_DISPATCH_POLL_INTERVAL_MS = 2_000;
const WORKFLOW_MUTATION_HEARTBEAT_INTERVAL_MS = Math.max(1_000, Math.floor(WORKFLOW_MUTATION_LEASE_MS / 3));

const slaBursts = [
  {
    name: 'workflow mutation submit acknowledgment burst',
    completeness: 'The mutation intent is durably accepted before the caller sees success.',
    samplesMs: [31, 35, 37, 44, 52, 58, 63, 71, 82, 96, 118],
    budget: {
      kind: 'max',
      maxMs: UI_ACK_BUDGET_MS,
      docBudget: 'User-visible UI action: ack within 200ms.',
    },
    queue: {
      name: 'mutation',
      outcomes: ['accepted', 'accepted', 'accepted', 'accepted', 'accepted', 'accepted'],
    },
  },
  {
    name: 'workflow selection mini-DAG visibility burst',
    completeness: 'The selected workflow mini-DAG is visible and bound to the clicked workflow.',
    samplesMs: [17, 22, 25, 31, 37, 44, 58, 67, 83],
    budget: {
      kind: 'max',
      maxMs: WORKFLOW_SELECTION_VISIBLE_BUDGET_MS,
      docBudget: 'Workflow selection: visible within 100ms.',
    },
  },
  {
    name: 'main-process cheap IPC under status-poll load',
    completeness: 'Cheap IPC remains accepted while status work is running.',
    samplesMs: [
      34, 36, 39, 42, 47, 51, 55, 61, 66, 70,
      74, 81, 89, 97, 108, 121, 143, 177, 196, 238,
    ],
    budget: {
      kind: 'p95-and-max',
      p95Ms: CHEAP_IPC_P95_BUDGET_MS,
      maxMs: CHEAP_IPC_MAX_BUDGET_MS,
      docBudget: 'Main-process cheap IPC under load: p95 <= 200ms, max sample <= 250ms.',
    },
  },
  {
    name: 'task context menu visibility burst',
    completeness: 'The requested menu becomes visible and stays interactive.',
    samplesMs: [48, 53, 59, 64, 72, 85, 96, 111, 129, 157],
    budget: {
      kind: 'max',
      maxMs: UI_ACK_BUDGET_MS,
      docBudget: 'Task and workflow context menus: visible within 200ms.',
    },
  },
  {
    name: 'PR-facing quality shard finish burst',
    completeness: 'Each required PR quality job or Playwright shard finishes its own configured work.',
    samplesMs: [132_000, 151_000, 177_000, 214_000, 246_000, 281_000],
    budget: {
      kind: 'under',
      maxMs: PR_QUALITY_JOB_BUDGET_MS,
      docBudget: 'PR-facing quality jobs: under 5 minutes per budgeted job or shard.',
    },
  },
  {
    name: 'launch handoff outbox poll burst',
    completeness: 'Each launch dispatch is accepted by the next standalone dispatcher poll.',
    samplesMs: [248, 612, 975, 1_384, 1_811, 1_996],
    budget: {
      kind: 'poll-intervals',
      intervalMs: STANDALONE_LAUNCH_DISPATCH_POLL_INTERVAL_MS,
      intervals: 1,
      docBudget: 'Launch handoff is poll-cadence bounded; do not apply the UI action 200ms ack budget.',
    },
    queue: {
      name: 'launch',
      outcomes: ['accepted', 'accepted', 'accepted', 'accepted', 'accepted'],
    },
  },
  {
    name: 'mutation lease heartbeat renewal burst',
    completeness: 'Lease renewals are recorded through the heartbeat queue while long mutations continue.',
    samplesMs: [1_004, 1_118, 1_246, 1_381, 1_542, 1_704, 1_899],
    budget: {
      kind: 'poll-intervals',
      intervalMs: WORKFLOW_MUTATION_HEARTBEAT_INTERVAL_MS,
      intervals: 1,
      docBudget: 'Mutation heartbeat is interval-cadence bounded, not a UI acknowledgment.',
    },
    queue: {
      name: 'heartbeat',
      outcomes: ['accepted', 'accepted', 'accepted', 'accepted'],
    },
  },
] satisfies readonly SlaBurstFixture[];

function percentile(values: readonly number[], percentileRank: number): number {
  if (values.length === 0) throw new Error('Cannot compute percentile for an empty sample set');
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(sorted.length * percentileRank) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))]!;
}

function maxSample(values: readonly number[]): number {
  if (values.length === 0) throw new Error('Cannot compute max for an empty sample set');
  return Math.max(...values);
}

function assertWithinBudget(fixture: SlaBurstFixture): void {
  const maxMs = maxSample(fixture.samplesMs);
  const evidence = `${fixture.name}: samples=[${fixture.samplesMs.join(', ')}], budget=${fixture.budget.docBudget}`;

  switch (fixture.budget.kind) {
    case 'max':
      expect(maxMs, evidence).toBeLessThanOrEqual(fixture.budget.maxMs);
      return;
    case 'p95-and-max': {
      const p95Ms = percentile(fixture.samplesMs, 0.95);
      expect(p95Ms, evidence).toBeLessThanOrEqual(fixture.budget.p95Ms);
      expect(maxMs, evidence).toBeLessThanOrEqual(fixture.budget.maxMs);
      return;
    }
    case 'under':
      expect(maxMs, evidence).toBeLessThan(fixture.budget.maxMs);
      return;
    case 'poll-intervals':
      expect(maxMs, evidence).toBeLessThanOrEqual(fixture.budget.intervalMs * fixture.budget.intervals);
      return;
  }
}

describe('choke SLA eval fixtures', () => {
  it('keeps known burst samples inside their declared latency budgets', () => {
    for (const fixture of slaBursts) {
      expect(fixture.completeness.length, `${fixture.name} must name its completeness signal`).toBeGreaterThan(0);
      assertWithinBudget(fixture);
    }
  });

  it('finishes queue-backed bursts with no unaccounted work', () => {
    for (const fixture of slaBursts.filter((candidate) => candidate.queue)) {
      const metrics = new ChokeBoundaryMetrics({ nowMs: () => 1_000 });
      const queue = fixture.queue!;

      queue.outcomes.forEach((outcome, index) => {
        const key = `${fixture.name}:${index}`;
        if (outcome === 'accepted') metrics.recordQueueAccepted(queue.name, key);
        else metrics.recordQueueRejected(queue.name, key);
      });

      const snapshot = metrics.getQueueSnapshot(queue.name);
      const accepted = queue.outcomes.filter((outcome) => outcome === 'accepted').length;
      const rejected = queue.outcomes.length - accepted;
      expect(snapshot.complete, fixture.name).toBe(accepted);
      expect(snapshot.failed, fixture.name).toBe(rejected);
      expect(snapshot.unaccounted, fixture.name).toBe(0);
      expect(snapshot.complete + snapshot.failed, fixture.name).toBe(queue.outcomes.length);
    }
  });

  it('keeps launch on a poll-interval budget instead of the UI acknowledgment budget', () => {
    const launch = slaBursts.find((fixture) => fixture.queue?.name === 'launch');

    expect(launch).toBeDefined();
    expect(launch!.budget.kind).toBe('poll-intervals');
    expect(maxSample(launch!.samplesMs)).toBeGreaterThan(UI_ACK_BUDGET_MS);
    expect(launch!.budget).toMatchObject({
      intervalMs: STANDALONE_LAUNCH_DISPATCH_POLL_INTERVAL_MS,
      intervals: 1,
    });
  });
});
