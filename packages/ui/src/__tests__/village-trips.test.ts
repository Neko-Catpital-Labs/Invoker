import { describe, expect, it } from 'vitest';
import type { WorkerActionSummary, WorkerStatusEntry, WorkerStatusSnapshot } from '../types.js';
import {
  FOUNTAIN_LANDMARK_ID,
  buildVillageWorld,
  countVillageActiveTrips,
} from '../lib/village-trips.js';

function action(partial: Partial<WorkerActionSummary> & Pick<WorkerActionSummary, 'id' | 'workerKind' | 'actionType' | 'subjectType' | 'subjectId' | 'status'>): WorkerActionSummary {
  return {
    externalKey: partial.externalKey ?? partial.id,
    attemptCount: partial.attemptCount ?? 1,
    createdAt: partial.createdAt ?? '2026-08-27T12:00:00.000Z',
    updatedAt: partial.updatedAt ?? '2026-08-27T12:00:00.000Z',
    ...partial,
  };
}

function worker(partial: Partial<WorkerStatusEntry> & Pick<WorkerStatusEntry, 'kind'>): WorkerStatusEntry {
  return {
    note: partial.note ?? `${partial.kind} worker`,
    lifecycle: partial.lifecycle ?? 'running',
    policy: partial.policy ?? 'enabled',
    autoStarts: partial.autoStarts ?? true,
    startable: partial.startable ?? true,
    stoppable: partial.stoppable ?? true,
    recentActions: partial.recentActions ?? [],
    ...partial,
  };
}

function snapshot(workers: WorkerStatusEntry[]): WorkerStatusSnapshot {
  return { generatedAt: '2026-08-27T12:00:00.000Z', workers };
}

describe('buildVillageWorld', () => {
  it('maps active autofix actions to illusion trips toward PR shops', () => {
    const world = buildVillageWorld(snapshot([
      worker({
        kind: 'autofix',
        recentActions: [
          action({
            id: 'af-1',
            workerKind: 'autofix',
            actionType: 'repair-ci',
            subjectType: 'pr',
            subjectId: '1234',
            status: 'running',
          }),
          action({
            id: 'af-2',
            workerKind: 'autofix',
            actionType: 'repair-ci',
            subjectType: 'pr',
            subjectId: '5678',
            status: 'queued',
          }),
          action({
            id: 'af-done',
            workerKind: 'autofix',
            actionType: 'repair-ci',
            subjectType: 'pr',
            subjectId: '9999',
            status: 'completed',
          }),
        ],
      }),
    ]));

    expect(world.trips).toHaveLength(2);
    expect(world.activeTripCount).toBe(2);
    expect(world.trips.map((t) => t.destLandmarkId).sort()).toEqual([
      'shop:pr:1234',
      'shop:pr:5678',
    ]);
    expect(world.heroes[0]?.mood).toBe('working');
    expect(world.heroes[0]?.tripCount).toBe(2);
    expect(world.landmarks.some((l) => l.id === 'barracks:autofix')).toBe(true);
  });

  it('fans out reaper invoker-home actions into remote outpost trips', () => {
    const payloads = new Map<string, unknown>([
      ['reaper-1', {
        orphanResults: [{ name: 'mac-mini', ok: true }],
        worktreeResults: [{ name: 'gpu-box', ok: true }],
      }],
    ]);
    const world = buildVillageWorld(
      snapshot([
        worker({
          kind: 'reaper',
          recentActions: [
            action({
              id: 'reaper-1',
              workerKind: 'reaper',
              actionType: 'reaper-pass',
              subjectType: 'invoker-home',
              subjectId: '/Users/me/.invoker',
              status: 'running',
            }),
          ],
        }),
      ]),
      { actionPayloads: payloads, remoteTargets: ['mac-mini', 'gpu-box', 'unused'] },
    );

    expect(world.trips).toHaveLength(2);
    expect(world.trips.every((t) => t.sourceLandmarkId === FOUNTAIN_LANDMARK_ID)).toBe(true);
    expect(world.trips.map((t) => t.destLandmarkId).sort()).toEqual([
      'outpost:gpu-box',
      'outpost:mac-mini',
    ]);
  });

  it('fans out reaper to configured remotes when payload has no target names', () => {
    const world = buildVillageWorld(
      snapshot([
        worker({
          kind: 'reaper',
          recentActions: [
            action({
              id: 'reaper-2',
              workerKind: 'reaper',
              actionType: 'reaper-pass',
              subjectType: 'invoker-home',
              subjectId: 'home',
              status: 'pending',
            }),
          ],
        }),
      ]),
      { remoteTargets: ['alpha', 'beta'] },
    );
    expect(world.trips).toHaveLength(2);
    expect(world.trips.map((t) => t.destLandmarkId).sort()).toEqual([
      'outpost:alpha',
      'outpost:beta',
    ]);
  });

  it('skips unknown empty subjects and keeps a generic pad for odd types', () => {
    const world = buildVillageWorld(snapshot([
      worker({
        kind: 'disk-headroom',
        recentActions: [
          action({
            id: 'bad',
            workerKind: 'disk-headroom',
            actionType: 'scan',
            subjectType: '  ',
            subjectId: 'x',
            status: 'running',
          }),
          action({
            id: 'odd',
            workerKind: 'disk-headroom',
            actionType: 'scan',
            subjectType: 'widget',
            subjectId: '42',
            status: 'running',
          }),
        ],
      }),
    ]));
    expect(world.trips).toHaveLength(1);
    expect(world.trips[0]?.destLandmarkId).toBe('pad:widget:42');
    expect(world.landmarks.some((l) => l.kind === 'pad')).toBe(true);
  });

  it('marks long-quiet running workers as sleep without hiding them', () => {
    const world = buildVillageWorld(
      snapshot([
        worker({
          kind: 'pr-status',
          lifecycle: 'running',
          recentActions: [
            action({
              id: 'old',
              workerKind: 'pr-status',
              actionType: 'poll',
              subjectType: 'workflow',
              subjectId: 'wf-1',
              status: 'completed',
              updatedAt: '2026-08-27T10:00:00.000Z',
            }),
          ],
        }),
      ]),
      { nowMs: Date.parse('2026-08-27T12:00:00.000Z') },
    );
    expect(world.heroes).toHaveLength(1);
    expect(world.heroes[0]?.mood).toBe('sleep');
    expect(world.heroes[0]?.statusChip).toBe('sleep');
    expect(world.trips).toHaveLength(0);
  });

  it('despawns trips when actions leave active statuses', () => {
    const base = worker({
      kind: 'ci-failure',
      recentActions: [
        action({
          id: 'ci-1',
          workerKind: 'ci-failure',
          actionType: 'repair',
          subjectType: 'pr',
          subjectId: '1',
          status: 'running',
        }),
      ],
    });
    expect(countVillageActiveTrips(snapshot([base]))).toBe(1);
    expect(countVillageActiveTrips(snapshot([
      worker({
        ...base,
        recentActions: [
          action({
            id: 'ci-1',
            workerKind: 'ci-failure',
            actionType: 'repair',
            subjectType: 'pr',
            subjectId: '1',
            status: 'completed',
          }),
        ],
      }),
    ]))).toBe(0);
  });

  it('returns empty world for null snapshot', () => {
    const world = buildVillageWorld(null);
    expect(world.heroes).toEqual([]);
    expect(world.trips).toEqual([]);
    expect(world.landmarks.some((l) => l.id === FOUNTAIN_LANDMARK_ID)).toBe(true);
  });
});
