/**
 * Pure village world mapping: WorkerStatusSnapshot → heroes, landmarks, illusion trips.
 * No DOM. Used by the Village tab and mirrored by the Go island.
 */

import type {
  WorkerActionStatus,
  WorkerActionSummary,
  WorkerStatusEntry,
  WorkerStatusSnapshot,
} from '../types.js';
import {
  ACTIVE_WORKER_ACTION_STATUSES,
  formatWorkerValue,
  getWorkerDisplayCopy,
} from './worker-display.js';

export const VILLAGE_SLEEP_MS = 15 * 60 * 1000;
export const FOUNTAIN_LANDMARK_ID = 'landmark:fountain';

export type VillageLandmarkKind = 'fountain' | 'outpost' | 'shop' | 'jungle' | 'pad' | 'barracks';

export type VillageHeroMood = 'working' | 'idle' | 'sleep';

export interface VillageLandmark {
  readonly id: string;
  readonly kind: VillageLandmarkKind;
  readonly label: string;
}

export interface VillageTrip {
  readonly id: string;
  readonly workerKind: string;
  readonly actionId: string;
  readonly actionType: string;
  readonly status: WorkerActionStatus;
  readonly sourceLandmarkId: string;
  readonly destLandmarkId: string;
  readonly goalWord: string;
}

export interface VillageHero {
  readonly workerKind: string;
  readonly name: string;
  readonly title: string;
  readonly lifecycle: string;
  readonly mood: VillageHeroMood;
  readonly tripCount: number;
  readonly goalWord: string;
  readonly statusChip: string;
  readonly barracksLandmarkId: string;
}

export interface VillageWorld {
  readonly heroes: readonly VillageHero[];
  readonly landmarks: readonly VillageLandmark[];
  readonly trips: readonly VillageTrip[];
  readonly activeTripCount: number;
  readonly generatedAt: string;
}

export interface BuildVillageWorldOptions {
  readonly remoteTargets?: readonly string[];
  readonly nowMs?: number;
  readonly sleepAfterMs?: number;
  /** Optional action payloads keyed by action id (Go / extended feeds). */
  readonly actionPayloads?: ReadonlyMap<string, unknown>;
}

interface MutableLandmark {
  id: string;
  kind: VillageLandmarkKind;
  label: string;
}

function isActiveStatus(status: WorkerActionStatus): boolean {
  return ACTIVE_WORKER_ACTION_STATUSES.has(status);
}

function goalWordFromActionType(actionType: string): string {
  const part = actionType.split(/[-_/]/).filter(Boolean)[0] ?? actionType;
  return part.slice(0, 12);
}

function barracksId(workerKind: string): string {
  return `barracks:${workerKind}`;
}

function ensureLandmark(
  map: Map<string, MutableLandmark>,
  id: string,
  kind: VillageLandmarkKind,
  label: string,
): void {
  if (map.has(id)) return;
  map.set(id, { id, kind, label });
}

function classifySubject(
  subjectType: string,
  subjectId: string,
  remoteNames: ReadonlySet<string>,
): { kind: VillageLandmarkKind; label: string; id: string } | null {
  const type = subjectType.trim().toLowerCase();
  const id = subjectId.trim();
  if (!type || !id) return null;

  if (type === 'invoker-home' || type === 'local' || type === 'host' && id === 'local') {
    return { kind: 'fountain', label: 'Fountain', id: FOUNTAIN_LANDMARK_ID };
  }

  if (
    type === 'remote'
    || type === 'remote-host'
    || type === 'ssh'
    || type === 'host'
    || remoteNames.has(id)
  ) {
    return { kind: 'outpost', label: id, id: `outpost:${id}` };
  }

  if (type === 'pr' || type === 'pull_request' || type === 'github-pr' || type.startsWith('pr')) {
    return { kind: 'shop', label: `PR ${id}`, id: `shop:pr:${id}` };
  }

  if (type === 'workflow' || type === 'workflow-id') {
    return { kind: 'jungle', label: id.slice(0, 16), id: `jungle:${id}` };
  }

  if (type === 'task') {
    return { kind: 'pad', label: id.slice(0, 16), id: `pad:task:${id}` };
  }

  return { kind: 'pad', label: `${formatWorkerValue(type)} ${id}`.slice(0, 24), id: `pad:${type}:${id}` };
}

function remoteNamesFromPayload(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const record = payload as Record<string, unknown>;
  const names: string[] = [];

  const collect = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const row = entry as Record<string, unknown>;
      const name = typeof row.name === 'string'
        ? row.name
        : typeof row.target === 'string'
          ? row.target
          : typeof row.host === 'string'
            ? row.host
            : undefined;
      if (name && name.trim()) names.push(name.trim());
    }
  };

  collect(record.orphanResults);
  collect(record.worktreeResults);
  collect(record.remoteResults);
  collect(record.targets);

  if (Array.isArray(record.remoteTargets)) {
    for (const entry of record.remoteTargets) {
      if (typeof entry === 'string' && entry.trim()) names.push(entry.trim());
      else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const name = (entry as Record<string, unknown>).name;
        if (typeof name === 'string' && name.trim()) names.push(name.trim());
      }
    }
  }

  return [...new Set(names)];
}

function lastActivityMs(worker: WorkerStatusEntry): number | null {
  let latest: number | null = null;
  for (const action of worker.recentActions) {
    const stamp = Date.parse(action.updatedAt || action.createdAt);
    if (!Number.isFinite(stamp)) continue;
    if (latest === null || stamp > latest) latest = stamp;
  }
  return latest;
}

function heroMood(
  worker: WorkerStatusEntry,
  tripCount: number,
  nowMs: number,
  sleepAfterMs: number,
): VillageHeroMood {
  if (tripCount > 0) return 'working';
  if (worker.lifecycle !== 'running') return 'idle';
  const last = lastActivityMs(worker);
  if (last === null || nowMs - last >= sleepAfterMs) return 'sleep';
  return 'idle';
}

function tripsForAction(
  worker: WorkerStatusEntry,
  action: WorkerActionSummary,
  landmarks: Map<string, MutableLandmark>,
  remoteNames: ReadonlySet<string>,
  remoteList: readonly string[],
  payload: unknown | undefined,
): VillageTrip[] {
  if (!isActiveStatus(action.status)) return [];

  const homeId = barracksId(worker.kind);
  ensureLandmark(landmarks, homeId, 'barracks', getWorkerDisplayCopy(worker.kind).name);

  const type = action.subjectType.trim().toLowerCase();
  const isHomeSubject = type === 'invoker-home' || type === 'local';
  const isReaperFanout =
    (worker.kind === 'reaper' || action.actionType.includes('reaper'))
    && isHomeSubject;

  if (isReaperFanout) {
    const fromPayload = remoteNamesFromPayload(payload);
    const destNames = fromPayload.length > 0 ? fromPayload : [...remoteList];
    if (destNames.length === 0) {
      ensureLandmark(landmarks, FOUNTAIN_LANDMARK_ID, 'fountain', 'Fountain');
      return [{
        id: `${action.id}:fountain`,
        workerKind: worker.kind,
        actionId: action.id,
        actionType: action.actionType,
        status: action.status,
        sourceLandmarkId: homeId,
        destLandmarkId: FOUNTAIN_LANDMARK_ID,
        goalWord: goalWordFromActionType(action.actionType),
      }];
    }
    return destNames.map((name) => {
      const dest = classifySubject('remote', name, remoteNames)!;
      ensureLandmark(landmarks, FOUNTAIN_LANDMARK_ID, 'fountain', 'Fountain');
      ensureLandmark(landmarks, dest.id, dest.kind, dest.label);
      return {
        id: `${action.id}:${name}`,
        workerKind: worker.kind,
        actionId: action.id,
        actionType: action.actionType,
        status: action.status,
        sourceLandmarkId: FOUNTAIN_LANDMARK_ID,
        destLandmarkId: dest.id,
        goalWord: goalWordFromActionType(action.actionType),
      };
    });
  }

  const dest = classifySubject(action.subjectType, action.subjectId, remoteNames);
  if (!dest) return [];

  ensureLandmark(landmarks, dest.id, dest.kind, dest.label);
  const sourceId = dest.kind === 'outpost' ? FOUNTAIN_LANDMARK_ID : homeId;
  if (sourceId === FOUNTAIN_LANDMARK_ID) {
    ensureLandmark(landmarks, FOUNTAIN_LANDMARK_ID, 'fountain', 'Fountain');
  }

  return [{
    id: `${action.id}:0`,
    workerKind: worker.kind,
    actionId: action.id,
    actionType: action.actionType,
    status: action.status,
    sourceLandmarkId: sourceId,
    destLandmarkId: dest.id,
    goalWord: goalWordFromActionType(action.actionType),
  }];
}

/** Build the inspect-only village world from a worker status snapshot. */
export function buildVillageWorld(
  snapshot: WorkerStatusSnapshot | null | undefined,
  options: BuildVillageWorldOptions = {},
): VillageWorld {
  const nowMs = options.nowMs ?? Date.now();
  const sleepAfterMs = options.sleepAfterMs ?? VILLAGE_SLEEP_MS;
  const remoteList = (options.remoteTargets ?? []).map((name) => name.trim()).filter(Boolean);
  const remoteNameSet = new Set(remoteList);
  const landmarks = new Map<string, MutableLandmark>();
  ensureLandmark(landmarks, FOUNTAIN_LANDMARK_ID, 'fountain', 'Fountain');

  const trips: VillageTrip[] = [];
  const heroes: VillageHero[] = [];

  const workers = snapshot?.workers ?? [];
  for (const worker of workers) {
    const homeId = barracksId(worker.kind);
    ensureLandmark(landmarks, homeId, 'barracks', getWorkerDisplayCopy(worker.kind).name);

    const workerTrips: VillageTrip[] = [];
    for (const action of worker.recentActions) {
      const payload = options.actionPayloads?.get(action.id);
      workerTrips.push(
        ...tripsForAction(worker, action, landmarks, remoteNameSet, remoteList, payload),
      );
    }
    trips.push(...workerTrips);

    const copy = getWorkerDisplayCopy(worker.kind);
    const mood = heroMood(worker, workerTrips.length, nowMs, sleepAfterMs);
    const firstTrip = workerTrips[0];
    heroes.push({
      workerKind: worker.kind,
      name: copy.name,
      title: worker.note?.trim() ? worker.note.trim().slice(0, 48) : copy.name,
      lifecycle: worker.lifecycle,
      mood,
      tripCount: workerTrips.length,
      goalWord: firstTrip?.goalWord ?? (mood === 'sleep' ? 'zzz' : mood === 'idle' ? 'idle' : 'work'),
      statusChip: mood === 'working'
        ? (firstTrip?.status ?? 'running')
        : mood === 'sleep'
          ? 'sleep'
          : worker.lifecycle === 'running'
            ? 'idle'
            : worker.lifecycle,
      barracksLandmarkId: homeId,
    });
  }

  for (const name of remoteList) {
    ensureLandmark(landmarks, `outpost:${name}`, 'outpost', name);
  }

  return {
    heroes,
    landmarks: [...landmarks.values()],
    trips,
    activeTripCount: trips.length,
    generatedAt: snapshot?.generatedAt ?? new Date(nowMs).toISOString(),
  };
}

export function countVillageActiveTrips(
  snapshot: WorkerStatusSnapshot | null | undefined,
  options: BuildVillageWorldOptions = {},
): number {
  return buildVillageWorld(snapshot, options).activeTripCount;
}
