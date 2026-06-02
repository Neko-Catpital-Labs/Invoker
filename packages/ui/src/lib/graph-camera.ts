/**
 * Typed, persisted camera-preference and graph-navigation command model.
 *
 * The workflow graph and the selected workflow's task DAG share one vocabulary
 * for selection, active graph scope, camera lock, manual suppression, and
 * one-shot viewport commands. This module is the single owner of the monotonic
 * command sequence: no App selection handler should hand-roll `event++` or
 * `requestId++` to drive a camera move — it asks an issuer for a command.
 *
 * React Flow keeps owning its local x/y/zoom; these commands describe *intent*
 * (center this selection, fit the initial view) plus a monotonically-increasing
 * sequence so a consumer can detect "this is a new command" without comparing
 * deep equality of the payload.
 */

/** Which graph a command or preference applies to. */
export type GraphScope = 'workflow' | 'task';

/**
 * How the camera lock behaves:
 * - `toggle`: the lock stays engaged and re-centers on every selection change.
 * - `once`: the lock fires a single viewport move, then yields to manual pan/zoom.
 */
export type CameraMode = 'toggle' | 'once';

/** The kinds of viewport command an issuer can produce. */
export type GraphCameraCommandKind = 'centerSelection' | 'fitInitial';

/** Persisted user preference for the camera lock. */
export interface CameraLockPreference {
  mode: CameraMode;
  enabled: boolean;
}

/**
 * A one-shot viewport command. `sequence` is monotonic per issuer and is the
 * only field a consumer needs to watch to know a fresh command arrived; the
 * payload describes what the move should do, not how React Flow performs it.
 */
export interface GraphCameraCommand {
  kind: GraphCameraCommandKind;
  scope: GraphScope;
  /** Selection / node target the move should focus on, or `null` for whole-scope moves. */
  target: string | null;
  /** Human-readable reason the command was issued (selection change, initial load, …). */
  reason: string;
  /** Monotonically-increasing sequence number assigned by the issuer. */
  sequence: number;
}

/** Inputs for issuing a command. */
export interface GraphCameraCommandInit {
  scope: GraphScope;
  target?: string | null;
  reason?: string;
}

/** Default preference: lock engaged in toggle mode. */
export const DEFAULT_CAMERA_LOCK_PREFERENCE: CameraLockPreference = {
  mode: 'toggle',
  enabled: true,
};

/** localStorage key under which the camera lock preference is persisted. */
export const CAMERA_LOCK_STORAGE_KEY = 'invoker.graphCameraLockPreference';

const CAMERA_MODES: ReadonlySet<CameraMode> = new Set<CameraMode>(['toggle', 'once']);

function isCameraMode(value: unknown): value is CameraMode {
  return typeof value === 'string' && CAMERA_MODES.has(value as CameraMode);
}

/** Fresh copy of the defaults so callers can never mutate the shared constant. */
function defaultPreference(): CameraLockPreference {
  return { ...DEFAULT_CAMERA_LOCK_PREFERENCE };
}

/**
 * Coerce an arbitrary (possibly malformed) parsed value into a valid
 * preference, falling back to the default for any field that is missing or the
 * wrong type. Never throws.
 */
export function normalizeCameraLockPreference(value: unknown): CameraLockPreference {
  if (typeof value !== 'object' || value === null) {
    return defaultPreference();
  }
  const candidate = value as Record<string, unknown>;
  return {
    mode: isCameraMode(candidate.mode) ? candidate.mode : DEFAULT_CAMERA_LOCK_PREFERENCE.mode,
    enabled:
      typeof candidate.enabled === 'boolean'
        ? candidate.enabled
        : DEFAULT_CAMERA_LOCK_PREFERENCE.enabled,
  };
}

/**
 * Resolve the Storage to use: an explicit one (tests), else `globalThis`'s
 * localStorage when available. Returns `null` when no storage exists so
 * load/save degrade gracefully (e.g. SSR / locked-down environments).
 */
function resolveStorage(storage?: Storage | null): Storage | null {
  if (storage !== undefined) return storage;
  try {
    const candidate = (globalThis as { localStorage?: Storage }).localStorage;
    return candidate ?? null;
  } catch {
    return null;
  }
}

/**
 * Load the persisted preference. Any failure — no storage, missing key,
 * unparseable JSON, or malformed shape — yields the defaults.
 */
export function loadCameraLockPreference(storage?: Storage | null): CameraLockPreference {
  const store = resolveStorage(storage);
  if (!store) return defaultPreference();
  let raw: string | null;
  try {
    raw = store.getItem(CAMERA_LOCK_STORAGE_KEY);
  } catch {
    return defaultPreference();
  }
  if (raw === null) return defaultPreference();
  try {
    return normalizeCameraLockPreference(JSON.parse(raw));
  } catch {
    return defaultPreference();
  }
}

/**
 * Persist the preference. Returns `true` on success, `false` when there is no
 * storage or the write throws (quota, private mode, …). Never throws.
 */
export function saveCameraLockPreference(
  preference: CameraLockPreference,
  storage?: Storage | null,
): boolean {
  const store = resolveStorage(storage);
  if (!store) return false;
  try {
    store.setItem(CAMERA_LOCK_STORAGE_KEY, JSON.stringify(preference));
    return true;
  } catch {
    return false;
  }
}

/**
 * The single owner of the monotonic camera-command sequence. Every viewport
 * command in the app must come from an issuer so that no selection handler
 * re-implements `event++` / `requestId++` by hand.
 */
export class GraphCameraCommandIssuer {
  private sequence = 0;

  private issue(kind: GraphCameraCommandKind, init: GraphCameraCommandInit): GraphCameraCommand {
    // The one and only place the sequence advances.
    this.sequence += 1;
    return {
      kind,
      scope: init.scope,
      target: init.target ?? null,
      reason: init.reason ?? kind,
      sequence: this.sequence,
    };
  }

  /** Center the viewport on the current selection. */
  centerSelection(init: GraphCameraCommandInit): GraphCameraCommand {
    return this.issue('centerSelection', init);
  }

  /** Fit the whole graph into view (e.g. on initial load of a scope). */
  fitInitial(init: GraphCameraCommandInit): GraphCameraCommand {
    return this.issue('fitInitial', init);
  }

  /** The sequence number most recently assigned (0 before any command). */
  get currentSequence(): number {
    return this.sequence;
  }

  /** Reset the counter — primarily for tests and full graph teardown. */
  reset(): void {
    this.sequence = 0;
  }
}

/** Construct a fresh command issuer with its own independent sequence. */
export function createGraphCameraCommandIssuer(): GraphCameraCommandIssuer {
  return new GraphCameraCommandIssuer();
}
