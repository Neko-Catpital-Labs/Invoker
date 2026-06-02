/**
 * Graph camera model — a typed, persisted vocabulary for workflow/task graph navigation.
 *
 * Centralizes selection scope, camera lock preference, manual-pan suppression, and one-shot
 * viewport commands so that App selection handlers never need to roll their own ad hoc
 * `event++` / `requestId++` counters. The single monotonic sequence lives here, incremented
 * only inside {@link createCameraCommandIssuer}.
 *
 * React Flow keeps owning x/y/zoom locally; these commands are intent signals (center this
 * selection, fit on initial mount), not a fully controlled viewport.
 */

/** Which graph a camera command or lock applies to. */
export type GraphScope = 'workflow' | 'task';

/**
 * Camera lock behavior:
 * - `toggle`: the lock stays engaged, continuously re-centering on selection changes.
 * - `once`: the lock centers a single time, then releases (one-shot follow).
 */
export type CameraMode = 'toggle' | 'once';

/** User preference for the camera lock — persisted across sessions. */
export interface CameraLockPreference {
  mode: CameraMode;
  enabled: boolean;
}

/**
 * Runtime lock state. The persisted {@link CameraLockPreference} plus ephemeral runtime data:
 * which scope the lock is currently bound to, and whether a manual pan/zoom has temporarily
 * suppressed auto-centering (and on which scope it was suppressed).
 */
export interface CameraLockState {
  preference: CameraLockPreference;
  /** Graph the lock is currently active on, or `null` when not bound to a scope. */
  activeScope: GraphScope | null;
  /** True when a manual interaction has temporarily paused auto-centering. */
  temporarilySuppressed: boolean;
  /** Scope on which suppression happened, or `null` when not suppressed. */
  suppressedScope: GraphScope | null;
}

/** Kind of one-shot viewport command. */
export type GraphCameraCommandKind = 'centerSelection' | 'fitInitial';

/**
 * A one-shot viewport command. `sequence` is monotonic and is the deduplication / freshness key
 * consumers compare against the last-applied value — replacing ad hoc `requestId++` state.
 */
export interface GraphCameraCommand {
  kind: GraphCameraCommandKind;
  scope: GraphScope;
  /** Node/selection id to center on. Required for `centerSelection`; omitted for `fitInitial`. */
  targetId?: string;
  /** Human-readable cause, useful for debugging why the camera moved. */
  reason: string;
  /** Monotonic, strictly increasing. Only {@link createCameraCommandIssuer} mutates this. */
  sequence: number;
}

/** Default lock preference: toggle mode, enabled. */
export const DEFAULT_CAMERA_LOCK_PREFERENCE: CameraLockPreference = {
  mode: 'toggle',
  enabled: true,
};

/** Default runtime lock state derived from the default preference. */
export const DEFAULT_CAMERA_LOCK_STATE: CameraLockState = {
  preference: { ...DEFAULT_CAMERA_LOCK_PREFERENCE },
  activeScope: null,
  temporarilySuppressed: false,
  suppressedScope: null,
};

/** localStorage key for the persisted camera lock preference. */
export const CAMERA_LOCK_STORAGE_KEY = 'invoker.graphCameraLockPreference';

const CAMERA_MODES: ReadonlySet<CameraMode> = new Set<CameraMode>(['toggle', 'once']);

function isCameraMode(value: unknown): value is CameraMode {
  return typeof value === 'string' && CAMERA_MODES.has(value as CameraMode);
}

/**
 * Validate an unknown value into a {@link CameraLockPreference}, falling back to defaults for any
 * missing or malformed field. Never throws.
 */
export function normalizeCameraLockPreference(value: unknown): CameraLockPreference {
  if (typeof value !== 'object' || value === null) {
    return { ...DEFAULT_CAMERA_LOCK_PREFERENCE };
  }
  const raw = value as Record<string, unknown>;
  return {
    mode: isCameraMode(raw.mode) ? raw.mode : DEFAULT_CAMERA_LOCK_PREFERENCE.mode,
    enabled:
      typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_CAMERA_LOCK_PREFERENCE.enabled,
  };
}

/** Safely resolve localStorage; returns null when window/localStorage is unavailable. */
function getStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    const storage = window.localStorage;
    return storage ?? null;
  } catch {
    // Accessing localStorage can throw (e.g. disabled cookies / sandboxed iframe).
    return null;
  }
}

/**
 * Load the persisted camera lock preference. Tolerates a missing window/localStorage, absent key,
 * malformed JSON, and partially-valid objects — always returns a complete preference.
 */
export function loadCameraLockPreference(): CameraLockPreference {
  const storage = getStorage();
  if (!storage) return { ...DEFAULT_CAMERA_LOCK_PREFERENCE };
  let stored: string | null;
  try {
    stored = storage.getItem(CAMERA_LOCK_STORAGE_KEY);
  } catch {
    return { ...DEFAULT_CAMERA_LOCK_PREFERENCE };
  }
  if (stored === null) return { ...DEFAULT_CAMERA_LOCK_PREFERENCE };
  try {
    return normalizeCameraLockPreference(JSON.parse(stored));
  } catch {
    return { ...DEFAULT_CAMERA_LOCK_PREFERENCE };
  }
}

/**
 * Persist the camera lock preference. No-op (returns false) when storage is unavailable or the
 * write throws (e.g. quota exceeded). Returns true on success.
 */
export function saveCameraLockPreference(preference: CameraLockPreference): boolean {
  const storage = getStorage();
  if (!storage) return false;
  try {
    storage.setItem(CAMERA_LOCK_STORAGE_KEY, JSON.stringify(preference));
    return true;
  } catch {
    return false;
  }
}

/** Options for issuing a camera command (everything except the auto-assigned sequence). */
export interface IssueCameraCommandOptions {
  kind: GraphCameraCommandKind;
  scope: GraphScope;
  targetId?: string;
  reason: string;
}

/** Function that mints fresh {@link GraphCameraCommand}s with a monotonic sequence. */
export type CameraCommandIssuer = (options: IssueCameraCommandOptions) => GraphCameraCommand;

/**
 * Create the single command factory. This is the ONLY place a camera-command sequence is
 * incremented — consumers call the returned issuer instead of maintaining their own counter.
 *
 * @param startSequence Sequence to begin from; the first issued command uses `startSequence + 1`.
 */
export function createCameraCommandIssuer(startSequence = 0): CameraCommandIssuer {
  let sequence = startSequence;
  return ({ kind, scope, targetId, reason }) => {
    sequence += 1;
    const command: GraphCameraCommand = { kind, scope, reason, sequence };
    if (targetId !== undefined) command.targetId = targetId;
    return command;
  };
}
