/**
 * Typed, persisted camera preference and graph navigation command model.
 *
 * Both the workflow graph and the selected workflow task DAG share this
 * vocabulary for selection, active graph scope, camera lock, manual
 * suppression, and one-shot viewport commands.
 *
 * Design notes:
 * - React Flow keeps owning x/y/zoom locally; this module never makes the
 *   viewport fully controlled. It only describes *intents* (commands) and the
 *   persisted lock preference. Manual pan/zoom stay responsive.
 * - Monotonic command sequencing lives entirely in {@link createCameraCommandIssuer}.
 *   No App-level `event++` / `requestId++` is needed anywhere else.
 */

/** Which graph a selection / command applies to. */
export type GraphScope = 'workflow' | 'task';

/**
 * How the camera lock behaves.
 * - `toggle`: lock stays on and keeps re-centering on selection until disabled.
 * - `once`: the lock applies a single time, then stops following selection.
 */
export type CameraMode = 'toggle' | 'once';

/** Persisted user preference for the camera lock. */
export interface CameraLockPreference {
  mode: CameraMode;
  enabled: boolean;
}

/**
 * Runtime state of the camera lock.
 *
 * `temporarilySuppressed` is set when the user manually pans/zooms while a
 * lock is active: the preference stays `enabled`, but auto-centering is paused
 * until selection changes again.
 */
export interface CameraLockState {
  preference: CameraLockPreference;
  activeScope: GraphScope;
  temporarilySuppressed: boolean;
}

/** Kind of one-shot viewport command. */
export type GraphCameraCommandKind = 'centerSelection' | 'fitInitial';

/**
 * A one-shot viewport command issued to a graph.
 *
 * `sequence` is monotonically increasing and is the only signal a consumer
 * needs to detect a *new* command (it replaces ad hoc `requestId++` counters).
 */
export interface GraphCameraCommand {
  kind: GraphCameraCommandKind;
  scope: GraphScope;
  /** Node id to center on. Required for `centerSelection`; omitted for `fitInitial`. */
  targetId?: string;
  /** Human-readable reason, useful for debugging/telemetry. */
  reason: string;
  /** Monotonic, strictly increasing per issuer. */
  sequence: number;
}

/** Default preference: lock enabled, toggle mode. */
export const DEFAULT_CAMERA_LOCK_PREFERENCE: CameraLockPreference = {
  mode: 'toggle',
  enabled: true,
};

/** localStorage key for the persisted camera lock preference. */
export const CAMERA_LOCK_STORAGE_KEY = 'invoker.graphCamera.lockPreference';

const CAMERA_MODES: readonly CameraMode[] = ['toggle', 'once'];

function isCameraMode(value: unknown): value is CameraMode {
  return typeof value === 'string' && CAMERA_MODES.includes(value as CameraMode);
}

/**
 * Normalize an arbitrary value into a valid {@link CameraLockPreference}.
 * Unknown / malformed fields fall back to {@link DEFAULT_CAMERA_LOCK_PREFERENCE}.
 */
export function normalizeCameraLockPreference(value: unknown): CameraLockPreference {
  if (typeof value !== 'object' || value === null) {
    return { ...DEFAULT_CAMERA_LOCK_PREFERENCE };
  }
  const candidate = value as Partial<Record<keyof CameraLockPreference, unknown>>;
  const mode = isCameraMode(candidate.mode) ? candidate.mode : DEFAULT_CAMERA_LOCK_PREFERENCE.mode;
  const enabled =
    typeof candidate.enabled === 'boolean' ? candidate.enabled : DEFAULT_CAMERA_LOCK_PREFERENCE.enabled;
  return { mode, enabled };
}

/** Safely resolve a Storage instance, tolerating missing window/localStorage. */
function getStorage(): Storage | null {
  try {
    if (typeof globalThis !== 'undefined' && (globalThis as { localStorage?: Storage }).localStorage) {
      return (globalThis as { localStorage?: Storage }).localStorage ?? null;
    }
  } catch {
    // Accessing localStorage can throw (e.g. sandboxed/disabled storage).
  }
  return null;
}

/**
 * Load the persisted camera lock preference.
 * Returns defaults when storage is unavailable, missing, or malformed.
 */
export function loadCameraLockPreference(): CameraLockPreference {
  const storage = getStorage();
  if (!storage) {
    return { ...DEFAULT_CAMERA_LOCK_PREFERENCE };
  }
  let raw: string | null;
  try {
    raw = storage.getItem(CAMERA_LOCK_STORAGE_KEY);
  } catch {
    return { ...DEFAULT_CAMERA_LOCK_PREFERENCE };
  }
  if (raw === null) {
    return { ...DEFAULT_CAMERA_LOCK_PREFERENCE };
  }
  try {
    return normalizeCameraLockPreference(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_CAMERA_LOCK_PREFERENCE };
  }
}

/**
 * Persist the camera lock preference. No-op (returns false) when storage is
 * unavailable or the write throws.
 */
export function saveCameraLockPreference(preference: CameraLockPreference): boolean {
  const storage = getStorage();
  if (!storage) {
    return false;
  }
  try {
    storage.setItem(CAMERA_LOCK_STORAGE_KEY, JSON.stringify(normalizeCameraLockPreference(preference)));
    return true;
  } catch {
    return false;
  }
}

/** Input for issuing a command; `sequence` is supplied by the issuer. */
export type GraphCameraCommandInput = Omit<GraphCameraCommand, 'sequence'>;

/**
 * Create a command issuer. The returned function is the *only* place a
 * monotonic sequence is incremented — consumers compare `sequence` to detect
 * new commands instead of maintaining their own `event++`/`requestId++`.
 */
export function createCameraCommandIssuer(startSequence = 0): (input: GraphCameraCommandInput) => GraphCameraCommand {
  let sequence = startSequence;
  return (input: GraphCameraCommandInput): GraphCameraCommand => {
    sequence += 1;
    return { ...input, sequence };
  };
}
