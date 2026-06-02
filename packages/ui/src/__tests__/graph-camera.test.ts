import { describe, it, expect, beforeEach } from 'vitest';
import {
  CAMERA_LOCK_PREFERENCE_STORAGE_KEY,
  DEFAULT_CAMERA_LOCK_PREFERENCE,
  createGraphCameraIssuer,
  loadCameraLockPreference,
  saveCameraLockPreference,
  type CameraLockPreference,
} from '../lib/graph-camera.js';

/** Minimal in-memory Storage implementation for isolated test runs. */
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

/** Storage that throws on every operation — simulates locked-down browsers. */
class ThrowingStorage implements Storage {
  readonly length = 0;
  clear(): void {
    throw new Error('storage disabled');
  }
  getItem(): string | null {
    throw new Error('storage disabled');
  }
  key(): string | null {
    throw new Error('storage disabled');
  }
  removeItem(): void {
    throw new Error('storage disabled');
  }
  setItem(): void {
    throw new Error('storage disabled');
  }
}

describe('DEFAULT_CAMERA_LOCK_PREFERENCE', () => {
  it('defaults to toggle mode with lock enabled', () => {
    expect(DEFAULT_CAMERA_LOCK_PREFERENCE).toEqual({ mode: 'toggle', enabled: true });
  });

  it('is frozen to prevent accidental mutation of the canonical default', () => {
    expect(Object.isFrozen(DEFAULT_CAMERA_LOCK_PREFERENCE)).toBe(true);
  });
});

describe('loadCameraLockPreference', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('returns defaults when no value is stored', () => {
    expect(loadCameraLockPreference(storage)).toEqual({ mode: 'toggle', enabled: true });
  });

  it('returns defaults when storage is null (e.g., SSR / disabled)', () => {
    expect(loadCameraLockPreference(null)).toEqual({ mode: 'toggle', enabled: true });
  });

  it('returns defaults and does not throw when storage operations throw', () => {
    const throwing = new ThrowingStorage();
    expect(loadCameraLockPreference(throwing)).toEqual({ mode: 'toggle', enabled: true });
  });

  it('returns a fresh object — caller mutation must not corrupt the default', () => {
    const loaded = loadCameraLockPreference(storage);
    loaded.enabled = false;
    loaded.mode = 'once';
    expect(loadCameraLockPreference(storage)).toEqual({ mode: 'toggle', enabled: true });
    expect(DEFAULT_CAMERA_LOCK_PREFERENCE).toEqual({ mode: 'toggle', enabled: true });
  });

  it('reads a valid persisted preference verbatim', () => {
    storage.setItem(
      CAMERA_LOCK_PREFERENCE_STORAGE_KEY,
      JSON.stringify({ mode: 'once', enabled: false }),
    );
    expect(loadCameraLockPreference(storage)).toEqual({ mode: 'once', enabled: false });
  });

  it('falls back to defaults when stored value is not JSON', () => {
    storage.setItem(CAMERA_LOCK_PREFERENCE_STORAGE_KEY, 'not-json-at-all');
    expect(loadCameraLockPreference(storage)).toEqual({ mode: 'toggle', enabled: true });
  });

  it('falls back to defaults when stored value is JSON null', () => {
    storage.setItem(CAMERA_LOCK_PREFERENCE_STORAGE_KEY, 'null');
    expect(loadCameraLockPreference(storage)).toEqual({ mode: 'toggle', enabled: true });
  });

  it('falls back to defaults when stored value is a JSON primitive', () => {
    storage.setItem(CAMERA_LOCK_PREFERENCE_STORAGE_KEY, '42');
    expect(loadCameraLockPreference(storage)).toEqual({ mode: 'toggle', enabled: true });
  });

  it('falls back to defaults when fields are missing', () => {
    storage.setItem(CAMERA_LOCK_PREFERENCE_STORAGE_KEY, JSON.stringify({ enabled: true }));
    expect(loadCameraLockPreference(storage)).toEqual({ mode: 'toggle', enabled: true });
    storage.setItem(CAMERA_LOCK_PREFERENCE_STORAGE_KEY, JSON.stringify({ mode: 'once' }));
    expect(loadCameraLockPreference(storage)).toEqual({ mode: 'toggle', enabled: true });
  });

  it('falls back to defaults when fields have the wrong type', () => {
    storage.setItem(
      CAMERA_LOCK_PREFERENCE_STORAGE_KEY,
      JSON.stringify({ mode: 'toggle', enabled: 'yes' }),
    );
    expect(loadCameraLockPreference(storage)).toEqual({ mode: 'toggle', enabled: true });

    storage.setItem(
      CAMERA_LOCK_PREFERENCE_STORAGE_KEY,
      JSON.stringify({ mode: 42, enabled: true }),
    );
    expect(loadCameraLockPreference(storage)).toEqual({ mode: 'toggle', enabled: true });
  });

  it('falls back to defaults when mode is an unknown string', () => {
    storage.setItem(
      CAMERA_LOCK_PREFERENCE_STORAGE_KEY,
      JSON.stringify({ mode: 'continuous', enabled: false }),
    );
    expect(loadCameraLockPreference(storage)).toEqual({ mode: 'toggle', enabled: true });
  });
});

describe('saveCameraLockPreference', () => {
  it('round-trips through storage', () => {
    const storage = new MemoryStorage();
    const pref: CameraLockPreference = { mode: 'once', enabled: false };
    saveCameraLockPreference(pref, storage);
    expect(loadCameraLockPreference(storage)).toEqual(pref);
  });

  it('round-trips the default preference unchanged', () => {
    const storage = new MemoryStorage();
    saveCameraLockPreference({ ...DEFAULT_CAMERA_LOCK_PREFERENCE }, storage);
    expect(loadCameraLockPreference(storage)).toEqual(DEFAULT_CAMERA_LOCK_PREFERENCE);
  });

  it('overwrites a prior persisted value', () => {
    const storage = new MemoryStorage();
    saveCameraLockPreference({ mode: 'once', enabled: false }, storage);
    saveCameraLockPreference({ mode: 'toggle', enabled: true }, storage);
    expect(loadCameraLockPreference(storage)).toEqual({ mode: 'toggle', enabled: true });
  });

  it('silently no-ops when storage write throws', () => {
    const throwing = new ThrowingStorage();
    expect(() =>
      saveCameraLockPreference({ mode: 'once', enabled: false }, throwing),
    ).not.toThrow();
  });

  it('silently no-ops when storage is null', () => {
    expect(() =>
      saveCameraLockPreference({ mode: 'once', enabled: false }, null),
    ).not.toThrow();
  });

  it('writes only the schema fields, ignoring extras passed in', () => {
    const storage = new MemoryStorage();
    saveCameraLockPreference(
      { mode: 'once', enabled: false, junk: 'ignored' } as CameraLockPreference & { junk: string },
      storage,
    );
    const raw = storage.getItem(CAMERA_LOCK_PREFERENCE_STORAGE_KEY)!;
    expect(JSON.parse(raw)).toEqual({ mode: 'once', enabled: false });
  });
});

describe('createGraphCameraIssuer', () => {
  it('starts with sequence 0', () => {
    const issuer = createGraphCameraIssuer();
    expect(issuer.current()).toBe(0);
  });

  it('emits strictly increasing sequence numbers', () => {
    const issuer = createGraphCameraIssuer();
    const a = issuer.issue({ style: 'centerSelection', scope: 'workflow', target: 'wf-1', reason: 'select' });
    const b = issuer.issue({ style: 'centerSelection', scope: 'task', target: 't-2', reason: 'select' });
    const c = issuer.issue({ style: 'fitInitial', scope: 'workflow', target: null, reason: 'mount' });
    expect(a.sequence).toBe(1);
    expect(b.sequence).toBe(2);
    expect(c.sequence).toBe(3);
    expect(issuer.current()).toBe(3);
  });

  it('preserves the input fields verbatim and defaults target to null', () => {
    const issuer = createGraphCameraIssuer();
    const cmd = issuer.issue({
      style: 'centerSelection',
      scope: 'task',
      target: 'task-42',
      reason: 'user-selected-task',
    });
    expect(cmd).toEqual({
      style: 'centerSelection',
      scope: 'task',
      target: 'task-42',
      reason: 'user-selected-task',
      sequence: 1,
    });

    const fit = issuer.issue({ style: 'fitInitial', scope: 'workflow', reason: 'initial-mount' });
    expect(fit.target).toBeNull();
    expect(fit.sequence).toBe(2);
  });

  it('issues independent sequences across separate issuers', () => {
    const a = createGraphCameraIssuer();
    const b = createGraphCameraIssuer();
    a.issue({ style: 'fitInitial', scope: 'workflow', reason: 'mount' });
    a.issue({ style: 'fitInitial', scope: 'workflow', reason: 'mount' });
    const fromB = b.issue({ style: 'fitInitial', scope: 'workflow', reason: 'mount' });
    expect(a.current()).toBe(2);
    expect(fromB.sequence).toBe(1);
    expect(b.current()).toBe(1);
  });

  it('issues unique sequence numbers even for identical inputs', () => {
    const issuer = createGraphCameraIssuer();
    const input = { style: 'centerSelection' as const, scope: 'workflow' as const, target: 'x', reason: 'r' };
    const first = issuer.issue(input);
    const second = issuer.issue(input);
    expect(first.sequence).not.toBe(second.sequence);
    expect(second.sequence).toBeGreaterThan(first.sequence);
  });
});
