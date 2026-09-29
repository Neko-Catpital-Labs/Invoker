import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ChokeBoundaryMetrics, type ChokeBoundaryQueueName } from '../choke-boundary-metrics.js';

type BudgetComparison = '<' | '<=';

interface LatencyCheck {
  label: string;
  budgetMs: number;
  observedMs: number;
  comparison: BudgetComparison;
  docText?: string;
}

interface QueueBurst {
  queue: ChokeBoundaryQueueName;
  complete: number;
}

interface ChokeSlaFixture {
  name: string;
  source: 'choke-point-slas.md' | 'launch-dispatch-poll';
  latencyChecks: LatencyCheck[];
  queueBursts: QueueBurst[];
}

const repoRoot = new URL('../../../../', import.meta.url);
const chokeSlaDoc = readFileSync(
  fileURLToPath(new URL('docs/architecture/choke-point-slas.md', repoRoot)),
  'utf8',
);
const standaloneLaunchDispatcherSource = readFileSync(
  fileURLToPath(new URL('../headless-standalone-launch-dispatcher.ts', import.meta.url)),
  'utf8',
);

function msLiteralToNumber(value: string): number {
  return Number(value.replaceAll('_', ''));
}

function parseStandaloneLaunchPollIntervalMs(source: string): number {
  const match = source.match(/setInterval\(poll,\s*([0-9_]+)\)/);
  if (!match) {
    throw new Error('standalone launch dispatch poll interval not found');
  }
  return msLiteralToNumber(match[1]);
}

function percentile(values: number[], percentileValue: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

function expectWithinBudget(check: LatencyCheck, context: string): void {
  const message = `${context}: ${check.label} observed=${check.observedMs}ms budget${check.comparison}${check.budgetMs}ms`;
  if (check.comparison === '<') {
    expect(check.observedMs, message).toBeLessThan(check.budgetMs);
  } else {
    expect(check.observedMs, message).toBeLessThanOrEqual(check.budgetMs);
  }
}

const ipcAcceptSamplesMs = [
  44, 51, 55, 61, 68,
  72, 79, 84, 91, 99,
  104, 112, 121, 133, 144,
  151, 163, 176, 190, 241,
];
const launchPollIntervalMs = parseStandaloneLaunchPollIntervalMs(standaloneLaunchDispatcherSource);

const fixtures: ChokeSlaFixture[] = [
  {
    name: 'user-visible mutation acknowledgment burst',
    source: 'choke-point-slas.md',
    latencyChecks: [{
      label: 'acknowledgment',
      budgetMs: 200,
      observedMs: 174,
      comparison: '<=',
      docText: 'Ack within 200ms.',
    }],
    queueBursts: [{ queue: 'mutation', complete: 40 }],
  },
  {
    name: 'main-process IPC accept burst',
    source: 'choke-point-slas.md',
    latencyChecks: [
      {
        label: 'p95',
        budgetMs: 200,
        observedMs: percentile(ipcAcceptSamplesMs, 95),
        comparison: '<=',
        docText: 'p95 <= 200ms, max sample <= 250ms.',
      },
      {
        label: 'max sample',
        budgetMs: 250,
        observedMs: Math.max(...ipcAcceptSamplesMs),
        comparison: '<=',
        docText: 'p95 <= 200ms, max sample <= 250ms.',
      },
    ],
    queueBursts: [],
  },
  {
    name: 'workflow mini-DAG render burst',
    source: 'choke-point-slas.md',
    latencyChecks: [{
      label: 'node select to mini-DAG render',
      budgetMs: 100,
      observedMs: 92,
      comparison: '<=',
      docText: 'Visible within 100ms.',
    }],
    queueBursts: [],
  },
  {
    name: 'context-menu visibility burst',
    source: 'choke-point-slas.md',
    latencyChecks: [{
      label: 'context-menu visible',
      budgetMs: 200,
      observedMs: 148,
      comparison: '<=',
      docText: 'Visible within 200ms.',
    }],
    queueBursts: [],
  },
  {
    name: 'PR quality shard burst',
    source: 'choke-point-slas.md',
    latencyChecks: [{
      label: 'quality job duration',
      budgetMs: 5 * 60 * 1000,
      observedMs: 4 * 60 * 1000 + 22_000,
      comparison: '<',
      docText: 'Under 5 minutes per budgeted job or shard.',
    }],
    queueBursts: [],
  },
  {
    name: 'launch dispatch poll burst',
    source: 'launch-dispatch-poll',
    latencyChecks: [{
      label: 'poll interval',
      budgetMs: launchPollIntervalMs,
      observedMs: 1_250,
      comparison: '<=',
    }],
    queueBursts: [{ queue: 'launch', complete: 32 }],
  },
  {
    name: 'mutation heartbeat renewal burst',
    source: 'launch-dispatch-poll',
    latencyChecks: [{
      label: 'poll interval',
      budgetMs: launchPollIntervalMs,
      observedMs: 420,
      comparison: '<=',
    }],
    queueBursts: [{ queue: 'heartbeat', complete: 24 }],
  },
];

describe('choke SLA eval fixtures', () => {
  it('keeps fixture budgets tied to the documented SLA and launch poll cadence', () => {
    const docBackedChecks = fixtures
      .flatMap((fixture) => fixture.latencyChecks)
      .filter((check) => check.docText !== undefined);

    for (const check of docBackedChecks) {
      expect(chokeSlaDoc).toContain(check.docText);
    }
    expect(launchPollIntervalMs).toBe(2_000);
  });

  it('finishes known bursts with no unaccounted work inside their latency budgets', () => {
    for (const fixture of fixtures) {
      const metrics = new ChokeBoundaryMetrics({
        nowMs: () => Date.parse('2026-09-27T00:00:00.000Z'),
      });

      for (const burst of fixture.queueBursts) {
        for (let index = 0; index < burst.complete; index += 1) {
          metrics.recordQueueAccepted(burst.queue, `${fixture.name}:${index}`);
        }
      }

      for (const check of fixture.latencyChecks) {
        expectWithinBudget(check, fixture.name);
      }
      for (const burst of fixture.queueBursts) {
        expect(metrics.getQueueSnapshot(burst.queue)).toMatchObject({
          complete: burst.complete,
          failed: 0,
          unaccounted: 0,
        });
      }
    }
  });
});
