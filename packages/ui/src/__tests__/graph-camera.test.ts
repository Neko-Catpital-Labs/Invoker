import { describe, expect, it } from 'vitest';
import {
  CAMERA_LOCK_PREFERENCE_STORAGE_KEY,
  DEFAULT_CAMERA_LOCK_PREFERENCE,
  createCameraCommandIssuer,
  isCameraMode,
  isGraphScope,
  loadCameraLockPreference,
  parseCameraLockPreference,
  saveCameraLockPreference,
} from '../lib/graph-camera.js';
import type { CameraLockPreference } from '../lib/graph-camera.js';

/**
 * A minimal in-memory Storage stand-in so tests can drive the load/save paths
 * deterministically without leaking into the shared jsdom localStorage.
 */
function makeMemoryStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  } satisfies Storage;
}

describe('graph-camera defaults', () => {
  it('defaults to toggle mode with the lock enabled', () => {
    expect(DEFAULT_CAMERA_LOCK_PREFERENCE.mode).toBe('toggle');
    expect(DEFAULT_CAMERA_LOCK_PREFERENCE.enabled).toBe(true);
  });

  it('returns defaults when storage has no stored preference', () => {
    const storage = makeMemoryStorage();
    expect(loadCameraLockPreference(storage)).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
  });

  it('returns a fresh default object (not a shared mutable reference)', () => {
    const loaded = loadCameraLockPreference(makeMemoryStorage());
    loaded.enabled = false;
    expect(DEFAULT_CAMERA_LOCK_PREFERENCE.enabled).toBe(true);
  });
});

describe('graph-camera type guards', () => {
  it('recognizes valid graph scopes', () => {
    expect(isGraphScope('workflow')).toBe(true);
    expect(isGraphScope('task')).toBe(true);
    expect(isGraphScope('nope')).toBe(false);
    expect(isGraphScope(undefined)).toBe(false);
  });

  it('recognizes valid camera modes', () => {
    expect(isCameraMode('toggle')).toBe(true);
    expect(isCameraMode('once')).toBe(true);
    expect(isCameraMode('always')).toBe(false);
    expect(isCameraMode(42)).toBe(false);
  });
});

describe('graph-camera preference parsing', () => {
  it('accepts a well-formed preference', () => {
    const value: CameraLockPreference = { mode: 'once', enabled: false };
    expect(parseCameraLockPreference(value)).toEqual(value);
  });

  it.each([
    ['null', null],
    ['a primitive', 'toggle'],
    ['an unknown mode', { mode: 'always', enabled: true }],
    ['a non-boolean enabled', { mode: 'toggle', enabled: 'yes' }],
    ['a missing mode', { enabled: true }],
    ['a missing enabled', { mode: 'toggle' }],
  ])('rejects %s', (_label, value) => {
    expect(parseCameraLockPreference(value)).toBeNull();
  });
});

describe('graph-camera persisted values', () => {
  it('loads a valid persisted preference', () => {
    const stored: CameraLockPreference = { mode: 'once', enabled: false };
    const storage = makeMemoryStorage({
      [CAMERA_LOCK_PREFERENCE_STORAGE_KEY]: JSON.stringify(stored),
    });
    expect(loadCameraLockPreference(storage)).toEqual(stored);
  });

  it('falls back to defaults when the stored JSON is malformed', () => {
    const storage = makeMemoryStorage({
      [CAMERA_LOCK_PREFERENCE_STORAGE_KEY]: '{ this is not json',
    });
    expect(loadCameraLockPreference(storage)).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
  });

  it('falls back to defaults when the stored shape is invalid', () => {
    const storage = makeMemoryStorage({
      [CAMERA_LOCK_PREFERENCE_STORAGE_KEY]: JSON.stringify({ mode: 'always', enabled: 1 }),
    });
    expect(loadCameraLockPreference(storage)).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
  });

  it('round-trips a saved preference', () => {
    const storage = makeMemoryStorage();
    const preference: CameraLockPreference = { mode: 'once', enabled: false };
    saveCameraLockPreference(preference, storage);
    expect(storage.getItem(CAMERA_LOCK_PREFERENCE_STORAGE_KEY)).toBe(JSON.stringify(preference));
    expect(loadCameraLockPreference(storage)).toEqual(preference);
  });
});

describe('graph-camera persistence without storage', () => {
  it('falls back to defaults when no storage is available', () => {
    // No ambient localStorage in this test environment, and none passed in.
    expect(loadCameraLockPreference(null)).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
  });

  it('is a no-op (does not throw) when saving without storage', () => {
    expect(() => saveCameraLockPreference({ mode: 'once', enabled: false }, null)).not.toThrow();
  });
});

describe('graph-camera command issuer', () => {
  it('mints commands with a monotonic sequence starting at 1', () => {
    const issuer = createCameraCommandIssuer();
    expect(issuer.lastSequence()).toBe(0);

    const first = issuer.centerSelection({ scope: 'workflow', reason: 'selection-changed' });
    expect(first).toEqual({
      kind: 'centerSelection',
      scope: 'workflow',
      target: null,
      reason: 'selection-changed',
      sequence: 1,
    });

    const second = issuer.fitInitial({ scope: 'task', reason: 'initial-load', target: 'node-7' });
    expect(second.kind).toBe('fitInitial');
    expect(second.scope).toBe('task');
    expect(second.target).toBe('node-7');
    expect(second.sequence).toBe(2);
    expect(issuer.lastSequence()).toBe(2);
  });

  it('issues an explicit kind through issue()', () => {
    const issuer = createCameraCommandIssuer();
    const command = issuer.issue('fitInitial', {
      scope: 'workflow',
      reason: 'scope-changed',
      target: 'wf-1',
    });
    expect(command).toEqual({
      kind: 'fitInitial',
      scope: 'workflow',
      target: 'wf-1',
      reason: 'scope-changed',
      sequence: 1,
    });
  });

  it('honors a custom initial sequence and keeps incrementing strictly', () => {
    const issuer = createCameraCommandIssuer(10);
    const sequences = [
      issuer.centerSelection({ scope: 'task', reason: 'manual-recenter' }).sequence,
      issuer.centerSelection({ scope: 'task', reason: 'lock-engaged' }).sequence,
      issuer.fitInitial({ scope: 'workflow', reason: 'scope-changed' }).sequence,
    ];
    expect(sequences).toEqual([11, 12, 13]);
  });

  it('keeps separate issuers on independent sequences', () => {
    const a = createCameraCommandIssuer();
    const b = createCameraCommandIssuer();
    a.centerSelection({ scope: 'workflow', reason: 'selection-changed' });
    a.centerSelection({ scope: 'workflow', reason: 'selection-changed' });
    const fromB = b.centerSelection({ scope: 'task', reason: 'selection-changed' });
    expect(a.lastSequence()).toBe(2);
    expect(fromB.sequence).toBe(1);
  });
});
