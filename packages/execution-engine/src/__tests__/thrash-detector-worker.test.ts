import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  buildThrashSignatureId,
  createThrashDetectorWorker,
  normalizeFailureText,
  planThrashDetection,
  THRASH_DETECTED_EVENT_TYPE,
  type ThrashDetectorSourceEvent,
  type ThrashDetectorWorkerOptions,
  type ThrashDetectorWorkerStore,
} from '../workers/thrash-detector-worker.js';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as ThrashDetectorWorkerOptions['logger'];
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

const NOW = Date.parse('2026-01-01T12:00:00Z');

function event(taskId: string, hoursAgo: number, phase: string): ThrashDetectorSourceEvent {
  return {
    taskId,
    createdAt: iso(NOW - hoursAgo * 3_600_000),
    payload: { phase },
  };
}

describe('planThrashDetection', () => {
  it('groups the same signature across different task ids', () => {
    const events = [event('t1', 1, 'auto-fix-start'), event('t2', 2, 'auto-fix-start'), event('t3', 3, 'auto-fix-start')];
    const groups = planThrashDetection(events, () => 'Error: build failed at step 42', {
      now: NOW,
      windowHours: 24,
      thresholdCount: 3,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].taskIds).toEqual(['t1', 't2', 't3']);
    expect(groups[0].count).toBe(3);
  });

  it('does not group different signatures even with the same phase', () => {
    const events = [event('t1', 1, 'auto-fix-start'), event('t2', 1, 'auto-fix-start')];
    const outputs: Record<string, string> = {
      t1: 'Error: build failed at step 42',
      t2: 'Error: OAuth token expired',
    };
    const groups = planThrashDetection(events, (taskId) => outputs[taskId], {
      now: NOW,
      windowHours: 24,
      thresholdCount: 2,
    });
    expect(groups).toHaveLength(0);
  });

  it('does not report a signature below thresholdCount', () => {
    const events = [event('t1', 1, 'auto-fix-start'), event('t2', 2, 'auto-fix-start')];
    const groups = planThrashDetection(events, () => 'Error: build failed at step 42', {
      now: NOW,
      windowHours: 24,
      thresholdCount: 3,
    });
    expect(groups).toHaveLength(0);
  });

  it('excludes events outside windowHours', () => {
    const events = [event('t1', 1, 'auto-fix-start'), event('t2', 2, 'auto-fix-start'), event('t3', 30, 'auto-fix-start')];
    const groups = planThrashDetection(events, () => 'Error: build failed at step 42', {
      now: NOW,
      windowHours: 24,
      thresholdCount: 3,
    });
    expect(groups).toHaveLength(0);

    const widened = planThrashDetection(events, () => 'Error: build failed at step 42', {
      now: NOW,
      windowHours: 48,
      thresholdCount: 3,
    });
    expect(widened).toHaveLength(1);
    expect(widened[0].taskIds).toEqual(['t1', 't2', 't3']);
  });

  it('uses classifyPhase to bucket distinct phases into one signature', () => {
    const events = [event('t1', 1, 'poll-failed'), event('t2', 2, 'schedule-enter'), event('t3', 3, 'poll-failed')];
    const classifyPhase = (phase: string) => (phase === 'poll-failed' || phase === 'schedule-enter' ? 'scan' : phase);
    const groups = planThrashDetection(events, () => 'Error: build failed at step 42', {
      now: NOW,
      windowHours: 24,
      thresholdCount: 3,
      classifyPhase,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].signatureId.startsWith('scan:')).toBe(true);
  });

  it('does not bucket distinct phases together without classifyPhase', () => {
    const events = [event('t1', 1, 'poll-failed'), event('t2', 2, 'schedule-enter'), event('t3', 3, 'poll-failed')];
    const groups = planThrashDetection(events, () => 'Error: build failed at step 42', {
      now: NOW,
      windowHours: 24,
      thresholdCount: 3,
    });
    expect(groups).toHaveLength(0);
  });
});

describe('normalizeFailureText / buildThrashSignatureId', () => {
  it('normalizes volatile tokens so equivalent failures hash the same', () => {
    const a = normalizeFailureText('Task 123 failed at 2026-01-01T10:00:00Z with sha abc1234deadbeef');
    const b = normalizeFailureText('Task 456 failed at 2026-01-02T11:30:00Z with sha 9988776655443');
    expect(a).toBe(b);
  });

  it('produces different signature ids for different phase buckets on identical output', () => {
    const output = normalizeFailureText('Error: build failed');
    expect(buildThrashSignatureId('scan', output)).not.toBe(buildThrashSignatureId('submit', output));
  });
});

function makeStore(initialEvents: ThrashDetectorSourceEvent[], outputs: Record<string, string>): {
  store: ThrashDetectorWorkerStore;
  logged: Array<{ taskId: string; eventType: string; payload?: unknown }>;
} {
  const logged: Array<{ taskId: string; eventType: string; payload?: unknown }> = [];
  const store: ThrashDetectorWorkerStore = {
    getEventsByTypes: (eventTypes) => {
      if (eventTypes.includes(THRASH_DETECTED_EVENT_TYPE)) {
        return logged
          .filter((entry) => entry.eventType === THRASH_DETECTED_EVENT_TYPE)
          .map((entry) => ({ taskId: entry.taskId, createdAt: iso(NOW), payload: entry.payload }));
      }
      return initialEvents;
    },
    getTaskOutput: (taskId) => outputs[taskId] ?? '',
    logEvent: (taskId, eventType, payload) => {
      logged.push({ taskId, eventType, payload });
    },
  };
  return { store, logged };
}

describe('createThrashDetectorWorker', () => {
  it('logs exactly one thrash.detected event per qualifying signature', async () => {
    const events = [event('t1', 1, 'auto-fix-start'), event('t2', 2, 'auto-fix-start'), event('t3', 3, 'auto-fix-start')];
    const { store, logged } = makeStore(events, {
      t1: 'Error: build failed at step 42',
      t2: 'Error: build failed at step 42',
      t3: 'Error: build failed at step 42',
    });

    const worker = createThrashDetectorWorker({
      logger: makeLogger(),
      store,
      thresholdCount: 3,
      windowHours: 24,
      tickOnStart: false,
      now: () => NOW,
    });
    await worker.tick('manual');

    const thrashEvents = logged.filter((entry) => entry.eventType === THRASH_DETECTED_EVENT_TYPE);
    expect(thrashEvents).toHaveLength(1);
    const payload = thrashEvents[0].payload as Record<string, unknown>;
    expect(payload.taskIds).toEqual(['t1', 't2', 't3']);
    expect(payload.count).toBe(3);
    expect(payload.windowHours).toBe(24);
    expect(typeof payload.signatureId).toBe('string');
  });

  it('does not re-log an already-recorded signature on a later tick', async () => {
    const events = [event('t1', 1, 'auto-fix-start'), event('t2', 2, 'auto-fix-start'), event('t3', 3, 'auto-fix-start')];
    const { store, logged } = makeStore(events, {
      t1: 'Error: build failed at step 42',
      t2: 'Error: build failed at step 42',
      t3: 'Error: build failed at step 42',
    });

    const worker = createThrashDetectorWorker({
      logger: makeLogger(),
      store,
      thresholdCount: 3,
      windowHours: 24,
      tickOnStart: false,
      now: () => NOW,
    });
    await worker.tick('manual');
    await worker.tick('manual');

    expect(logged.filter((entry) => entry.eventType === THRASH_DETECTED_EVENT_TYPE)).toHaveLength(1);
  });

  it('never calls anything but getEventsByTypes / getTaskOutput / logEvent(thrash.detected) on the store', async () => {
    const events = [event('t1', 1, 'auto-fix-start'), event('t2', 2, 'auto-fix-start'), event('t3', 3, 'auto-fix-start')];
    const { store, logged } = makeStore(events, {
      t1: 'Error: build failed at step 42',
      t2: 'Error: build failed at step 42',
      t3: 'Error: build failed at step 42',
    });

    const worker = createThrashDetectorWorker({
      logger: makeLogger(),
      store,
      thresholdCount: 3,
      windowHours: 24,
      tickOnStart: false,
      now: () => NOW,
    });
    await worker.tick('manual');

    for (const entry of logged) {
      expect(entry.eventType).toBe(THRASH_DETECTED_EVENT_TYPE);
    }
  });
});

describe('thrash-detector-worker safety invariant', () => {
  const workerSourcePath = fileURLToPath(new URL('../workers/thrash-detector-worker.ts', import.meta.url));
  const workerSource = readFileSync(workerSourcePath, 'utf-8');

  it('never references a mutation channel, approval path, or recreate-task path', () => {
    for (const forbidden of [
      'invoker:fix-with-agent',
      'invoker:approve',
      'invoker:recreate-task',
      'recreate-task',
      'submitter',
      '.submit(',
    ]) {
      expect(workerSource).not.toContain(forbidden);
    }
  });
});
