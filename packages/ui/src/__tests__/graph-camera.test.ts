import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DEFAULT_CAMERA_LOCK_PREFERENCE,
  CAMERA_LOCK_STORAGE_KEY,
  normalizeCameraLockPreference,
  loadCameraLockPreference,
  saveCameraLockPreference,
  createCameraCommandIssuer,
  type CameraLockPreference,
  type GraphCameraCommand,
} from '../lib/graph-camera.js';

describe('DEFAULT_CAMERA_LOCK_PREFERENCE', () => {
  it('defaults to toggle mode and enabled lock', () => {
    expect(DEFAULT_CAMERA_LOCK_PREFERENCE).toEqual({ mode: 'toggle', enabled: true });
  });
});

describe('normalizeCameraLockPreference', () => {
  it('passes through a fully valid preference', () => {
    const valid: CameraLockPreference = { mode: 'once', enabled: false };
    expect(normalizeCameraLockPreference(valid)).toEqual(valid);
  });

  it('falls back to defaults for non-object values', () => {
    expect(normalizeCameraLockPreference(null)).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
    expect(normalizeCameraLockPreference('toggle')).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
    expect(normalizeCameraLockPreference(42)).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
    expect(normalizeCameraLockPreference(undefined)).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
  });

  it('replaces an invalid mode while keeping a valid enabled flag', () => {
    expect(normalizeCameraLockPreference({ mode: 'spin', enabled: false })).toEqual({
      mode: 'toggle',
      enabled: false,
    });
  });

  it('replaces a non-boolean enabled while keeping a valid mode', () => {
    expect(normalizeCameraLockPreference({ mode: 'once', enabled: 'yes' })).toEqual({
      mode: 'once',
      enabled: true,
    });
  });
});

/**
 * Minimal in-memory Storage stub. The test jsdom environment does not expose a
 * `localStorage` global, so we install our own to exercise the persistence path
 * deterministically.
 */
function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe('loadCameraLockPreference / saveCameraLockPreference', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createMemoryStorage();
    vi.stubGlobal('localStorage', storage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns defaults when nothing is stored', () => {
    expect(loadCameraLockPreference()).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
  });

  it('round-trips a saved preference', () => {
    const pref: CameraLockPreference = { mode: 'once', enabled: false };
    expect(saveCameraLockPreference(pref)).toBe(true);
    expect(loadCameraLockPreference()).toEqual(pref);
  });

  it('falls back to defaults when stored JSON is malformed', () => {
    localStorage.setItem(CAMERA_LOCK_STORAGE_KEY, '{not valid json');
    expect(loadCameraLockPreference()).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
  });

  it('falls back to defaults when stored value has invalid fields', () => {
    localStorage.setItem(CAMERA_LOCK_STORAGE_KEY, JSON.stringify({ mode: 'bogus', enabled: 'nope' }));
    expect(loadCameraLockPreference()).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
  });

  it('persists a normalized preference even when given partially invalid input', () => {
    saveCameraLockPreference({ mode: 'wat', enabled: false } as unknown as CameraLockPreference);
    expect(loadCameraLockPreference()).toEqual({ mode: 'toggle', enabled: false });
  });

  it('returns defaults when localStorage getItem throws', () => {
    vi.spyOn(storage, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    expect(loadCameraLockPreference()).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
  });

  it('reports failure (false) when localStorage setItem throws', () => {
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    expect(saveCameraLockPreference(DEFAULT_CAMERA_LOCK_PREFERENCE)).toBe(false);
  });
});

describe('createCameraCommandIssuer', () => {
  it('produces strictly increasing sequence numbers', () => {
    const issue = createCameraCommandIssuer();
    const first = issue({ kind: 'fitInitial', scope: 'workflow', reason: 'initial load' });
    const second = issue({ kind: 'centerSelection', scope: 'task', targetId: 't1', reason: 'selection changed' });
    const third = issue({ kind: 'centerSelection', scope: 'workflow', targetId: 'wf-2', reason: 'selection changed' });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(third.sequence).toBe(3);
  });

  it('preserves the command fields and honors a custom start sequence', () => {
    const issue = createCameraCommandIssuer(10);
    const cmd: GraphCameraCommand = issue({
      kind: 'centerSelection',
      scope: 'task',
      targetId: 'task-7',
      reason: 'user selected task',
    });
    expect(cmd).toEqual({
      kind: 'centerSelection',
      scope: 'task',
      targetId: 'task-7',
      reason: 'user selected task',
      sequence: 11,
    });
  });

  it('keeps independent issuers from sharing a counter', () => {
    const a = createCameraCommandIssuer();
    const b = createCameraCommandIssuer();
    a({ kind: 'fitInitial', scope: 'workflow', reason: 'a1' });
    a({ kind: 'fitInitial', scope: 'workflow', reason: 'a2' });
    const bCmd = b({ kind: 'fitInitial', scope: 'workflow', reason: 'b1' });
    expect(bCmd.sequence).toBe(1);
  });
});
