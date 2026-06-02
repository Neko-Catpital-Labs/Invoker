/**
 * Shared vocabulary for graph camera behavior across the workflow graph and the
 * selected workflow's task DAG.
 *
 * This module is the single source of truth for:
 *   - which graph a camera command targets (`GraphScope`)
 *   - whether the camera lock re-applies continuously or once (`CameraMode`)
 *   - the persisted user preference for the lock (`CameraLockPreference`)
 *   - one-shot viewport commands (`GraphCameraCommand`)
 *
 * It deliberately owns the *only* monotonic sequence used to issue camera
 * commands. Consumers must route every command through a
 * `CameraCommandIssuer` (see {@link createCameraCommandIssuer}) instead of
 * maintaining ad hoc `event++` / `requestId++` counters in their own state.
 *
 * Note on architecture: React Flow keeps owning x/y/zoom locally so manual pan
 * and zoom stay responsive. These commands are one-shot *requests* to recenter
 * or fit — they are not a controlled viewport.
 */

/** Which graph a camera command applies to. */
export type GraphScope = 'workflow' | 'task';

/**
 * How the camera lock behaves:
 *   - `toggle`: the lock stays engaged and re-applies as selection changes.
 *   - `once`: the lock applies a single time, then releases to manual control.
 */
export type CameraMode = 'toggle' | 'once';

/** The style of viewport command being issued. */
export type GraphCameraCommandKind = 'centerSelection' | 'fitInitial';

/** Why a camera command was issued — useful for debugging and suppression. */
export type GraphCameraReason =
  | 'selection-changed'
  | 'initial-load'
  | 'scope-changed'
  | 'manual-recenter'
  | 'lock-engaged';

/** The persisted user preference controlling the camera lock. */
export interface CameraLockPreference {
  /** Whether the lock re-applies continuously (`toggle`) or once (`once`). */
  mode: CameraMode;
  /** Whether the camera lock is engaged at all. */
  enabled: boolean;
}

/**
 * A one-shot viewport command. The `sequence` is monotonic and is only ever
 * produced by a {@link CameraCommandIssuer}; consumers compare it against the
 * last-applied sequence to decide whether a command is fresh.
 */
export interface GraphCameraCommand {
  kind: GraphCameraCommandKind;
  scope: GraphScope;
  /** The selection/node id to center on, or `null` for scope-wide commands. */
  target: string | null;
  reason: GraphCameraReason;
  /** Monotonically increasing; unique per issuer. */
  sequence: number;
}

/** Default preference: lock engaged, re-applying as selection changes. */
export const DEFAULT_CAMERA_LOCK_PREFERENCE: CameraLockPreference = {
  mode: 'toggle',
  enabled: true,
};

/** localStorage key for the persisted camera lock preference. */
export const CAMERA_LOCK_PREFERENCE_STORAGE_KEY = 'invoker.graph.cameraLockPreference';

const GRAPH_SCOPES: ReadonlySet<GraphScope> = new Set<GraphScope>(['workflow', 'task']);
const CAMERA_MODES: ReadonlySet<CameraMode> = new Set<CameraMode>(['toggle', 'once']);

/** Type guard for {@link GraphScope}. */
export function isGraphScope(value: unknown): value is GraphScope {
  return typeof value === 'string' && GRAPH_SCOPES.has(value as GraphScope);
}

/** Type guard for {@link CameraMode}. */
export function isCameraMode(value: unknown): value is CameraMode {
  return typeof value === 'string' && CAMERA_MODES.has(value as CameraMode);
}

/**
 * Validate an arbitrary parsed value as a {@link CameraLockPreference}.
 * Returns `null` if the shape is malformed so callers can fall back to a
 * default.
 */
export function parseCameraLockPreference(value: unknown): CameraLockPreference | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (!isCameraMode(candidate.mode)) return null;
  if (typeof candidate.enabled !== 'boolean') return null;
  return { mode: candidate.mode, enabled: candidate.enabled };
}

/**
 * Resolve a usable Storage. Returns `null` when no Storage is available (e.g.
 * SSR / non-browser test contexts) so callers degrade to defaults instead of
 * throwing.
 */
function resolveStorage(storage?: Storage | null): Storage | null {
  if (storage) return storage;
  if (typeof globalThis !== 'undefined') {
    const candidate = (globalThis as { localStorage?: Storage }).localStorage;
    if (candidate) return candidate;
  }
  return null;
}

/**
 * Load the persisted camera lock preference. Any failure — missing storage,
 * absent key, malformed JSON, or an invalid shape — falls back to
 * {@link DEFAULT_CAMERA_LOCK_PREFERENCE}.
 */
export function loadCameraLockPreference(storage?: Storage | null): CameraLockPreference {
  const store = resolveStorage(storage);
  if (!store) return { ...DEFAULT_CAMERA_LOCK_PREFERENCE };
  try {
    const raw = store.getItem(CAMERA_LOCK_PREFERENCE_STORAGE_KEY);
    if (raw === null) return { ...DEFAULT_CAMERA_LOCK_PREFERENCE };
    const parsed = parseCameraLockPreference(JSON.parse(raw));
    return parsed ?? { ...DEFAULT_CAMERA_LOCK_PREFERENCE };
  } catch {
    return { ...DEFAULT_CAMERA_LOCK_PREFERENCE };
  }
}

/**
 * Persist the camera lock preference. Swallows storage errors (quota, disabled
 * storage) since a failed save must never break the UI.
 */
export function saveCameraLockPreference(
  preference: CameraLockPreference,
  storage?: Storage | null,
): void {
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    store.setItem(CAMERA_LOCK_PREFERENCE_STORAGE_KEY, JSON.stringify(preference));
  } catch {
    // Ignore: persistence is best-effort.
  }
}

/** Options for issuing a {@link GraphCameraCommand}. */
export interface IssueCameraCommandOptions {
  scope: GraphScope;
  reason: GraphCameraReason;
  /** Defaults to `null` (scope-wide command). */
  target?: string | null;
}

/**
 * The only object permitted to mint {@link GraphCameraCommand}s. It owns the
 * monotonic sequence; every issued command gets the next value. Consumers hold
 * a single issuer instead of incrementing their own counters.
 */
export interface CameraCommandIssuer {
  /** Issue a command of an explicit kind. */
  issue(kind: GraphCameraCommandKind, options: IssueCameraCommandOptions): GraphCameraCommand;
  /** Convenience for `issue('centerSelection', ...)`. */
  centerSelection(options: IssueCameraCommandOptions): GraphCameraCommand;
  /** Convenience for `issue('fitInitial', ...)`. */
  fitInitial(options: IssueCameraCommandOptions): GraphCameraCommand;
  /** The last sequence issued (0 before any command). */
  lastSequence(): number;
}

/**
 * Create a {@link CameraCommandIssuer}. The internal sequence is private to the
 * closure, guaranteeing this factory is the single place it increments.
 */
export function createCameraCommandIssuer(initialSequence = 0): CameraCommandIssuer {
  let sequence = initialSequence;

  function issue(
    kind: GraphCameraCommandKind,
    options: IssueCameraCommandOptions,
  ): GraphCameraCommand {
    sequence += 1;
    return {
      kind,
      scope: options.scope,
      target: options.target ?? null,
      reason: options.reason,
      sequence,
    };
  }

  return {
    issue,
    centerSelection: (options) => issue('centerSelection', options),
    fitInitial: (options) => issue('fitInitial', options),
    lastSequence: () => sequence,
  };
}
