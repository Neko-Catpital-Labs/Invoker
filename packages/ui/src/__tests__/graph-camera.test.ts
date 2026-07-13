import { describe, it, expect, beforeEach } from 'vitest';
import {
  CAMERA_LOCK_PREFERENCE_STORAGE_KEY,
  DEFAULT_CAMERA_LOCK_PREFERENCE,
  createGraphCameraCommandIssuer,
  isCameraMode,
  isGraphScope,
  loadCameraLockPreference,
  saveCameraLockPreference,
  type CameraLockPreference,
  type PreferenceStorage,
} from '../lib/graph-camera.js';

/** In-memory storage double matching the {@link PreferenceStorage} surface. */
function createMemoryStorage(seed?: Record<string, string>): PreferenceStorage & {
  raw: Map<string, string>;
} {
  const raw = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    raw,
    getItem: (key) => (raw.has(key) ? (raw.get(key) as string) : null),
    setItem: (key, value) => {
      raw.set(key, value);
    },
  };
}

describe('graph-camera defaults', () => {
  it('defaults to toggle mode with the lock enabled', () => {
    expect(DEFAULT_CAMERA_LOCK_PREFERENCE.mode).toBe('toggle');
    expect(DEFAULT_CAMERA_LOCK_PREFERENCE.enabled).toBe(true);
  });

  it('freezes the default so callers cannot mutate the shared constant', () => {
    expect(Object.isFrozen(DEFAULT_CAMERA_LOCK_PREFERENCE)).toBe(true);
  });

  it('returns the default for empty storage', () => {
    const storage = createMemoryStorage();
    expect(loadCameraLockPreference(storage)).toEqual({ mode: 'toggle', enabled: true });
  });

  it('returns a fresh copy, not the shared frozen default', () => {
    const loaded = loadCameraLockPreference(createMemoryStorage());
    expect(loaded).not.toBe(DEFAULT_CAMERA_LOCK_PREFERENCE);
    expect(Object.isFrozen(loaded)).toBe(false);
  });
});

describe('graph-camera type guards', () => {
  it('recognizes valid camera modes and scopes', () => {
    expect(isCameraMode('toggle')).toBe(true);
    expect(isCameraMode('once')).toBe(true);
    expect(isGraphScope('workflow')).toBe(true);
    expect(isGraphScope('task')).toBe(true);
  });

  it('rejects invalid camera modes and scopes', () => {
    expect(isCameraMode('always')).toBe(false);
    expect(isCameraMode(undefined)).toBe(false);
    expect(isCameraMode(2)).toBe(false);
    expect(isGraphScope('graph')).toBe(false);
    expect(isGraphScope(null)).toBe(false);
  });
});

describe('graph-camera persistence', () => {
  it('loads a valid persisted preference', () => {
    const stored: CameraLockPreference = { mode: 'once', enabled: false };
    const storage = createMemoryStorage({
      [CAMERA_LOCK_PREFERENCE_STORAGE_KEY]: JSON.stringify(stored),
    });
    expect(loadCameraLockPreference(storage)).toEqual(stored);
  });

  it('round-trips through save and load', () => {
    const storage = createMemoryStorage();
    const preference: CameraLockPreference = { mode: 'once', enabled: false };

    expect(saveCameraLockPreference(preference, storage)).toBe(true);
    expect(storage.raw.has(CAMERA_LOCK_PREFERENCE_STORAGE_KEY)).toBe(true);
    expect(loadCameraLockPreference(storage)).toEqual(preference);
  });

  it.each([
    ['not json at all', 'this is not json{'],
    ['a json primitive', '42'],
    ['a json null', 'null'],
    ['a json array', '[]'],
    ['an unknown mode', JSON.stringify({ mode: 'always', enabled: true })],
    ['a non-boolean enabled', JSON.stringify({ mode: 'toggle', enabled: 'yes' })],
    ['a missing mode', JSON.stringify({ enabled: true })],
    ['a missing enabled', JSON.stringify({ mode: 'toggle' })],
  ])('falls back to defaults for malformed storage: %s', (_label, rawValue) => {
    const storage = createMemoryStorage({
      [CAMERA_LOCK_PREFERENCE_STORAGE_KEY]: rawValue,
    });
    expect(loadCameraLockPreference(storage)).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
  });

  it('falls back to defaults when storage getItem throws', () => {
    const throwingStorage: PreferenceStorage = {
      getItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => {},
    };
    expect(loadCameraLockPreference(throwingStorage)).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
  });

  it('reports failure when saving to storage that throws', () => {
    const throwingStorage: PreferenceStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
    };
    expect(saveCameraLockPreference({ mode: 'toggle', enabled: true }, throwingStorage)).toBe(false);
  });
});

describe('graph-camera command issuer', () => {
  let issuer: ReturnType<typeof createGraphCameraCommandIssuer>;

  beforeEach(() => {
    issuer = createGraphCameraCommandIssuer();
  });

  it('starts at sequence 0 and issues monotonically increasing sequences', () => {
    expect(issuer.current()).toBe(0);
    const first = issuer.issue({ kind: 'centerSelection', scope: 'workflow', reason: 'select' });
    const second = issuer.issue({ kind: 'fitInitial', scope: 'task', reason: 'mount' });
    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(issuer.current()).toBe(2);
  });

  it('builds centerSelection commands with scope, target and reason', () => {
    const command = issuer.centerSelection('task', 'task-7', 'user click');
    expect(command).toEqual({
      kind: 'centerSelection',
      scope: 'task',
      target: 'task-7',
      reason: 'user click',
      sequence: 1,
    });
  });

  it('builds fitInitial commands with a null target', () => {
    const command = issuer.fitInitial('workflow');
    expect(command.kind).toBe('fitInitial');
    expect(command.scope).toBe('workflow');
    expect(command.target).toBeNull();
    expect(command.reason).toBe('fitInitial');
    expect(command.sequence).toBe(1);
  });

  it('defaults an omitted target to null', () => {
    const command = issuer.issue({ kind: 'fitInitial', scope: 'workflow', reason: 'reset' });
    expect(command.target).toBeNull();
  });

  it('keeps independent sequences per issuer', () => {
    const other = createGraphCameraCommandIssuer();
    issuer.centerSelection('workflow', 'a');
    issuer.centerSelection('workflow', 'b');
    const otherCommand = other.centerSelection('task', 'c');
    expect(issuer.current()).toBe(2);
    expect(otherCommand.sequence).toBe(1);
  });
});
