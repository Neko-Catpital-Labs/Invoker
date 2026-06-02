/**
 * Tests for the graph-camera model: preference defaults, persisted-value
 * normalization (valid + malformed), localStorage round trips, and the
 * monotonic camera-command sequence.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CAMERA_LOCK_STORAGE_KEY,
  DEFAULT_CAMERA_LOCK_PREFERENCE,
  createCameraCommandIssuer,
  defaultCameraLockPreference,
  initialCameraLockState,
  issueCameraCommand,
  loadCameraLockPreference,
  normalizeCameraLockPreference,
  saveCameraLockPreference,
  type CameraLockPreference,
} from '../lib/graph-camera.js';

describe('defaults', () => {
  it('uses toggle mode and enabled lock by default', () => {
    expect(DEFAULT_CAMERA_LOCK_PREFERENCE).toEqual({ mode: 'toggle', enabled: true });
  });

  it('returns a fresh copy from defaultCameraLockPreference', () => {
    const a = defaultCameraLockPreference();
    const b = defaultCameraLockPreference();
    expect(a).toEqual({ mode: 'toggle', enabled: true });
    expect(a).not.toBe(b);
    expect(a).not.toBe(DEFAULT_CAMERA_LOCK_PREFERENCE);
  });

  it('builds an idle initial lock state from defaults', () => {
    const state = initialCameraLockState();
    expect(state).toEqual({
      preference: { mode: 'toggle', enabled: true },
      activeScope: null,
      temporarilySuppressed: false,
    });
    // preference is copied, not shared with the default singleton
    expect(state.preference).not.toBe(DEFAULT_CAMERA_LOCK_PREFERENCE);
  });
});

describe('normalizeCameraLockPreference', () => {
  it('accepts a fully valid preference', () => {
    const valid: CameraLockPreference = { mode: 'once', enabled: false };
    expect(normalizeCameraLockPreference(valid)).toEqual(valid);
  });

  it('falls back to defaults for non-object inputs', () => {
    for (const bad of [null, undefined, 42, 'toggle', true, []]) {
      expect(normalizeCameraLockPreference(bad)).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
    }
  });

  it('repairs individual malformed fields', () => {
    expect(normalizeCameraLockPreference({ mode: 'spin', enabled: false })).toEqual({
      mode: 'toggle',
      enabled: false,
    });
    expect(normalizeCameraLockPreference({ mode: 'once', enabled: 'yes' })).toEqual({
      mode: 'once',
      enabled: true,
    });
    expect(normalizeCameraLockPreference({})).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
  });
});

/**
 * Minimal in-memory Storage stub. jsdom in this project does not expose
 * window.localStorage, so we install our own so the persistence helpers have a
 * real backing store to read/write/throw against.
 */
function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    key: (index: number) => Array.from(map.keys())[index] ?? null,
  };
}

describe('persistence', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createMemoryStorage());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns defaults when nothing is stored', () => {
    expect(loadCameraLockPreference()).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
  });

  it('round trips a saved preference', () => {
    const pref: CameraLockPreference = { mode: 'once', enabled: false };
    expect(saveCameraLockPreference(pref)).toBe(true);
    expect(loadCameraLockPreference()).toEqual(pref);
  });

  it('falls back to defaults when stored JSON is malformed', () => {
    window.localStorage.setItem(CAMERA_LOCK_STORAGE_KEY, '{not valid json');
    expect(loadCameraLockPreference()).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
  });

  it('falls back to defaults when stored value is wrong-shaped', () => {
    window.localStorage.setItem(CAMERA_LOCK_STORAGE_KEY, JSON.stringify({ mode: 'orbit' }));
    expect(loadCameraLockPreference()).toEqual({ mode: 'toggle', enabled: true });

    window.localStorage.setItem(CAMERA_LOCK_STORAGE_KEY, JSON.stringify([1, 2, 3]));
    expect(loadCameraLockPreference()).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
  });

  it('tolerates getItem throwing (blocked storage)', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadCameraLockPreference()).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
  });

  it('reports failure (and does not throw) when setItem throws', () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(saveCameraLockPreference({ mode: 'once', enabled: true })).toBe(false);
  });
});

describe('camera command issuance', () => {
  it('increments the sequence monotonically per issuer', () => {
    const issuer = createCameraCommandIssuer();
    const first = issuer.issue({
      kind: 'fitInitial',
      scope: 'workflow',
      reason: 'initial load',
    });
    const second = issuer.issue({
      kind: 'centerSelection',
      scope: 'task',
      targetId: 'node-7',
      reason: 'selection changed',
    });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(second.sequence).toBeGreaterThan(first.sequence);
    expect(issuer.peek()).toBe(2);
  });

  it('captures command fields and defaults targetId to null', () => {
    const issuer = createCameraCommandIssuer();
    const cmd = issuer.issue({ kind: 'fitInitial', scope: 'workflow', reason: 'reset' });
    expect(cmd).toEqual({
      kind: 'fitInitial',
      scope: 'workflow',
      targetId: null,
      reason: 'reset',
      sequence: 1,
    });

    const targeted = issuer.issue({
      kind: 'centerSelection',
      scope: 'task',
      targetId: 'task-42',
      reason: 'focus',
    });
    expect(targeted.targetId).toBe('task-42');
  });

  it('honors a custom initial sequence', () => {
    const issuer = createCameraCommandIssuer(10);
    expect(issuer.peek()).toBe(10);
    expect(issuer.issue({ kind: 'fitInitial', scope: 'task', reason: 'resume' }).sequence).toBe(
      11,
    );
  });

  it('keeps the shared default issuer monotonic across calls', () => {
    const a = issueCameraCommand({ kind: 'fitInitial', scope: 'workflow', reason: 'a' });
    const b = issueCameraCommand({ kind: 'centerSelection', scope: 'workflow', reason: 'b' });
    expect(b.sequence).toBeGreaterThan(a.sequence);
  });
});
