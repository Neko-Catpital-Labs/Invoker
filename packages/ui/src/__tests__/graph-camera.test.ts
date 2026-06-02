import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CAMERA_LOCK_STORAGE_KEY,
  DEFAULT_CAMERA_LOCK_PREFERENCE,
  DEFAULT_CAMERA_LOCK_STATE,
  createCameraCommandIssuer,
  loadCameraLockPreference,
  normalizeCameraLockPreference,
  saveCameraLockPreference,
  type CameraLockPreference,
} from '../lib/graph-camera.js';

describe('defaults', () => {
  it('default preference is toggle mode and enabled', () => {
    expect(DEFAULT_CAMERA_LOCK_PREFERENCE).toEqual({ mode: 'toggle', enabled: true });
  });

  it('default state derives from the default preference and is unbound/unsuppressed', () => {
    expect(DEFAULT_CAMERA_LOCK_STATE.preference).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
    expect(DEFAULT_CAMERA_LOCK_STATE.activeScope).toBeNull();
    expect(DEFAULT_CAMERA_LOCK_STATE.temporarilySuppressed).toBe(false);
    expect(DEFAULT_CAMERA_LOCK_STATE.suppressedScope).toBeNull();
  });

  it('default state preference is a copy, not a shared reference', () => {
    expect(DEFAULT_CAMERA_LOCK_STATE.preference).not.toBe(DEFAULT_CAMERA_LOCK_PREFERENCE);
  });
});

describe('normalizeCameraLockPreference', () => {
  it('passes through a fully valid preference', () => {
    const valid: CameraLockPreference = { mode: 'once', enabled: false };
    expect(normalizeCameraLockPreference(valid)).toEqual(valid);
  });

  it('falls back to defaults for an invalid mode', () => {
    expect(normalizeCameraLockPreference({ mode: 'spin', enabled: false })).toEqual({
      mode: 'toggle',
      enabled: false,
    });
  });

  it('falls back to defaults for a non-boolean enabled', () => {
    expect(normalizeCameraLockPreference({ mode: 'once', enabled: 'yes' })).toEqual({
      mode: 'once',
      enabled: true,
    });
  });

  it('returns defaults for non-object input', () => {
    expect(normalizeCameraLockPreference(null)).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
    expect(normalizeCameraLockPreference(42)).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
    expect(normalizeCameraLockPreference('toggle')).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
    expect(normalizeCameraLockPreference(undefined)).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
  });

  it('fills in missing fields from defaults', () => {
    expect(normalizeCameraLockPreference({})).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
    expect(normalizeCameraLockPreference({ mode: 'once' })).toEqual({ mode: 'once', enabled: true });
  });
});

/**
 * In-memory localStorage stand-in. jsdom in this environment does not provide localStorage, so the
 * persistence tests install this on `window.localStorage` to exercise the real read/write paths.
 */
function makeMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
  };
}

describe('persistence', () => {
  let originalDescriptor: PropertyDescriptor | undefined;

  function installStorage(storage: Storage | undefined): void {
    if (storage === undefined) {
      // Simulate an environment with no localStorage at all.
      Object.defineProperty(window, 'localStorage', { configurable: true, value: undefined });
      return;
    }
    Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  }

  beforeEach(() => {
    originalDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    installStorage(makeMemoryStorage());
  });

  afterEach(() => {
    if (originalDescriptor) {
      Object.defineProperty(window, 'localStorage', originalDescriptor);
    } else {
      // jsdom default: localStorage absent — restore that.
      Object.defineProperty(window, 'localStorage', { configurable: true, value: undefined });
    }
    vi.restoreAllMocks();
  });

  it('returns defaults when nothing is stored', () => {
    expect(loadCameraLockPreference()).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
  });

  it('returns defaults when window.localStorage is missing', () => {
    installStorage(undefined);
    expect(loadCameraLockPreference()).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
    expect(saveCameraLockPreference(DEFAULT_CAMERA_LOCK_PREFERENCE)).toBe(false);
  });

  it('round-trips a saved preference', () => {
    const pref: CameraLockPreference = { mode: 'once', enabled: false };
    expect(saveCameraLockPreference(pref)).toBe(true);
    expect(loadCameraLockPreference()).toEqual(pref);
  });

  it('falls back to defaults for malformed stored JSON', () => {
    window.localStorage.setItem(CAMERA_LOCK_STORAGE_KEY, '{not valid json');
    expect(loadCameraLockPreference()).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
  });

  it('falls back to defaults for structurally invalid stored values', () => {
    window.localStorage.setItem(CAMERA_LOCK_STORAGE_KEY, JSON.stringify({ mode: 'bogus', enabled: 7 }));
    expect(loadCameraLockPreference()).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
  });

  it('returns defaults when reading throws', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadCameraLockPreference()).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
  });

  it('save returns false when writing throws', () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    expect(saveCameraLockPreference(DEFAULT_CAMERA_LOCK_PREFERENCE)).toBe(false);
  });
});

describe('createCameraCommandIssuer', () => {
  it('increments the sequence monotonically across commands', () => {
    const issue = createCameraCommandIssuer();
    const a = issue({ kind: 'fitInitial', scope: 'workflow', reason: 'mount' });
    const b = issue({ kind: 'centerSelection', scope: 'task', targetId: 't1', reason: 'select' });
    const c = issue({ kind: 'centerSelection', scope: 'task', targetId: 't2', reason: 'select' });
    expect(a.sequence).toBe(1);
    expect(b.sequence).toBe(2);
    expect(c.sequence).toBe(3);
  });

  it('respects a custom start sequence', () => {
    const issue = createCameraCommandIssuer(10);
    expect(issue({ kind: 'fitInitial', scope: 'workflow', reason: 'mount' }).sequence).toBe(11);
  });

  it('carries through command fields including targetId', () => {
    const issue = createCameraCommandIssuer();
    const cmd = issue({
      kind: 'centerSelection',
      scope: 'task',
      targetId: 'node-9',
      reason: 'selection changed',
    });
    expect(cmd).toEqual({
      kind: 'centerSelection',
      scope: 'task',
      targetId: 'node-9',
      reason: 'selection changed',
      sequence: 1,
    });
  });

  it('omits targetId when not provided (e.g. fitInitial)', () => {
    const issue = createCameraCommandIssuer();
    const cmd = issue({ kind: 'fitInitial', scope: 'workflow', reason: 'initial fit' });
    expect(cmd.targetId).toBeUndefined();
    expect('targetId' in cmd).toBe(false);
  });

  it('separate issuers keep independent sequences', () => {
    const a = createCameraCommandIssuer();
    const b = createCameraCommandIssuer();
    a({ kind: 'fitInitial', scope: 'workflow', reason: 'x' });
    a({ kind: 'fitInitial', scope: 'workflow', reason: 'y' });
    expect(b({ kind: 'fitInitial', scope: 'workflow', reason: 'z' }).sequence).toBe(1);
  });
});
