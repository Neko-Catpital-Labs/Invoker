import { describe, expect, it } from 'vitest';
import {
  CAMERA_LOCK_STORAGE_KEY,
  DEFAULT_CAMERA_LOCK_PREFERENCE,
  createGraphCameraCommandIssuer,
  GraphCameraCommandIssuer,
  loadCameraLockPreference,
  normalizeCameraLockPreference,
  saveCameraLockPreference,
  type CameraLockPreference,
} from '../lib/graph-camera.js';

/** Minimal in-memory Storage stand-in for persistence tests. */
function createMemoryStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  } as Storage;
}

/** Storage whose mutators throw — models private mode / quota exhaustion. */
function createThrowingStorage(): Storage {
  const base = createMemoryStorage();
  return {
    ...base,
    getItem: () => {
      throw new Error('read blocked');
    },
    setItem: () => {
      throw new Error('write blocked');
    },
  } as Storage;
}

describe('graph-camera preference defaults', () => {
  it('defaults to toggle mode with the lock enabled', () => {
    expect(DEFAULT_CAMERA_LOCK_PREFERENCE).toEqual({ mode: 'toggle', enabled: true });
  });

  it('returns defaults when storage has no persisted value', () => {
    const storage = createMemoryStorage();
    expect(loadCameraLockPreference(storage)).toEqual({ mode: 'toggle', enabled: true });
  });

  it('returns defaults when no storage is available', () => {
    expect(loadCameraLockPreference(null)).toEqual({ mode: 'toggle', enabled: true });
  });

  it('does not allow callers to mutate the shared default constant', () => {
    const loaded = loadCameraLockPreference(null);
    loaded.enabled = false;
    loaded.mode = 'once';
    expect(DEFAULT_CAMERA_LOCK_PREFERENCE).toEqual({ mode: 'toggle', enabled: true });
  });
});

describe('graph-camera preference validation', () => {
  it('accepts a fully valid persisted value', () => {
    const stored: CameraLockPreference = { mode: 'once', enabled: false };
    const storage = createMemoryStorage({
      [CAMERA_LOCK_STORAGE_KEY]: JSON.stringify(stored),
    });
    expect(loadCameraLockPreference(storage)).toEqual(stored);
  });

  it('falls back to defaults on malformed JSON', () => {
    const storage = createMemoryStorage({ [CAMERA_LOCK_STORAGE_KEY]: '{not json' });
    expect(loadCameraLockPreference(storage)).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
  });

  it('repairs individual invalid fields against the defaults', () => {
    expect(normalizeCameraLockPreference({ mode: 'sideways', enabled: false })).toEqual({
      mode: 'toggle',
      enabled: false,
    });
    expect(normalizeCameraLockPreference({ mode: 'once', enabled: 'yes' })).toEqual({
      mode: 'once',
      enabled: true,
    });
  });

  it('falls back to defaults for non-object persisted values', () => {
    for (const bad of [null, undefined, 42, 'toggle', true, [], JSON.stringify(['once'])]) {
      expect(normalizeCameraLockPreference(bad)).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
    }
  });

  it('treats array / primitive JSON in storage as malformed and uses defaults', () => {
    const storage = createMemoryStorage({ [CAMERA_LOCK_STORAGE_KEY]: '["once", true]' });
    expect(loadCameraLockPreference(storage)).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
  });

  it('falls back to defaults when reading from storage throws', () => {
    expect(loadCameraLockPreference(createThrowingStorage())).toEqual(
      DEFAULT_CAMERA_LOCK_PREFERENCE,
    );
  });
});

describe('graph-camera preference persistence round trip', () => {
  it('saves then loads the same preference', () => {
    const storage = createMemoryStorage();
    const pref: CameraLockPreference = { mode: 'once', enabled: false };
    expect(saveCameraLockPreference(pref, storage)).toBe(true);
    expect(storage.getItem(CAMERA_LOCK_STORAGE_KEY)).toBe(JSON.stringify(pref));
    expect(loadCameraLockPreference(storage)).toEqual(pref);
  });

  it('reports failure without throwing when there is no storage', () => {
    expect(saveCameraLockPreference({ mode: 'toggle', enabled: true }, null)).toBe(false);
  });

  it('reports failure without throwing when the write throws', () => {
    expect(saveCameraLockPreference({ mode: 'toggle', enabled: true }, createThrowingStorage())).toBe(
      false,
    );
  });
});

describe('graph-camera command issuer', () => {
  it('starts at sequence 0 and increments monotonically per command', () => {
    const issuer = createGraphCameraCommandIssuer();
    expect(issuer.currentSequence).toBe(0);

    const first = issuer.centerSelection({ scope: 'workflow', target: 'wf-1' });
    const second = issuer.fitInitial({ scope: 'task', reason: 'initial load' });
    const third = issuer.centerSelection({ scope: 'task', target: 'task-9' });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(third.sequence).toBe(3);
    expect(issuer.currentSequence).toBe(3);
  });

  it('builds centerSelection commands with scope, target and reason', () => {
    const issuer = new GraphCameraCommandIssuer();
    const cmd = issuer.centerSelection({
      scope: 'workflow',
      target: 'wf-42',
      reason: 'selection change',
    });
    expect(cmd).toEqual({
      kind: 'centerSelection',
      scope: 'workflow',
      target: 'wf-42',
      reason: 'selection change',
      sequence: 1,
    });
  });

  it('defaults target to null and reason to the command kind', () => {
    const issuer = new GraphCameraCommandIssuer();
    const cmd = issuer.fitInitial({ scope: 'task' });
    expect(cmd.target).toBeNull();
    expect(cmd.reason).toBe('fitInitial');
    expect(cmd.kind).toBe('fitInitial');
    expect(cmd.scope).toBe('task');
  });

  it('keeps separate issuers on independent sequences', () => {
    const a = createGraphCameraCommandIssuer();
    const b = createGraphCameraCommandIssuer();
    a.centerSelection({ scope: 'workflow' });
    a.centerSelection({ scope: 'workflow' });
    const fromB = b.centerSelection({ scope: 'task' });
    expect(a.currentSequence).toBe(2);
    expect(fromB.sequence).toBe(1);
  });

  it('reset returns the sequence to zero', () => {
    const issuer = new GraphCameraCommandIssuer();
    issuer.centerSelection({ scope: 'workflow' });
    expect(issuer.currentSequence).toBe(1);
    issuer.reset();
    expect(issuer.currentSequence).toBe(0);
    expect(issuer.fitInitial({ scope: 'workflow' }).sequence).toBe(1);
  });
});
