/**
 * graph-camera — typed, persisted camera preference and graph-navigation command
 * model shared by the workflow graph and the selected-workflow task DAG.
 *
 * This module is the single source of truth for:
 *  - the camera-lock preference the user can persist (mode + enabled),
 *  - the runtime lock state (preference + active scope + temporary suppression),
 *  - one-shot viewport commands (center-selection / fit-initial).
 *
 * It deliberately owns the only monotonic sequence counter for camera commands,
 * so no App selection handler ever needs ad hoc `event++` / `requestId++` state.
 * React Flow keeps owning x/y/zoom locally; these commands are one-shot intents,
 * not a controlled viewport.
 */

/** Which graph a preference/command/state applies to. */
export type GraphScope = 'workflow' | 'task';

/**
 * How the camera lock behaves:
 *  - `toggle`: the lock stays engaged and re-centers on selection changes.
 *  - `once`: the lock centers a single time, then yields to manual control.
 */
export type CameraMode = 'toggle' | 'once';

/** The persisted, user-facing camera lock preference. */
export interface CameraLockPreference {
  mode: CameraMode;
  enabled: boolean;
}

/**
 * Runtime lock state. Wraps the persisted preference with transient,
 * non-persisted information about the live session.
 */
export interface CameraLockState {
  preference: CameraLockPreference;
  /** The scope the lock is currently driving, or null when idle. */
  activeScope: GraphScope | null;
  /**
   * True when the user has manually panned/zoomed and the lock has yielded
   * until the next explicit selection change. Never persisted.
   */
  temporarilySuppressed: boolean;
}

/** The kinds of one-shot viewport intents the camera model can issue. */
export type GraphCameraCommandKind = 'centerSelection' | 'fitInitial';

/**
 * A one-shot viewport command. Consumers compare `sequence` to detect a new
 * command rather than tracking their own counters. `targetId` is present for
 * commands that center on a specific node (e.g. centerSelection).
 */
export interface GraphCameraCommand {
  kind: GraphCameraCommandKind;
  scope: GraphScope;
  targetId: string | null;
  reason: string;
  sequence: number;
}

/** Default preference: toggle mode, lock enabled. */
export const DEFAULT_CAMERA_LOCK_PREFERENCE: CameraLockPreference = {
  mode: 'toggle',
  enabled: true,
};

/** localStorage key for the persisted camera lock preference. */
export const CAMERA_LOCK_STORAGE_KEY = 'invoker.graphCamera.lockPreference';

const CAMERA_MODES: ReadonlySet<CameraMode> = new Set<CameraMode>(['toggle', 'once']);

function isCameraMode(value: unknown): value is CameraMode {
  return typeof value === 'string' && CAMERA_MODES.has(value as CameraMode);
}

/**
 * Returns a fresh copy of the default preference. Always a new object so callers
 * can mutate freely without touching the shared default.
 */
export function defaultCameraLockPreference(): CameraLockPreference {
  return { ...DEFAULT_CAMERA_LOCK_PREFERENCE };
}

/**
 * Coerce an arbitrary parsed value into a valid CameraLockPreference, falling
 * back to defaults for any missing or malformed field.
 */
export function normalizeCameraLockPreference(value: unknown): CameraLockPreference {
  if (typeof value !== 'object' || value === null) {
    return defaultCameraLockPreference();
  }
  const record = value as Record<string, unknown>;
  return {
    mode: isCameraMode(record.mode) ? record.mode : DEFAULT_CAMERA_LOCK_PREFERENCE.mode,
    enabled:
      typeof record.enabled === 'boolean'
        ? record.enabled
        : DEFAULT_CAMERA_LOCK_PREFERENCE.enabled,
  };
}

/**
 * Build the initial runtime lock state from a preference (defaults when omitted).
 */
export function initialCameraLockState(
  preference: CameraLockPreference = defaultCameraLockPreference(),
): CameraLockState {
  return {
    preference: { ...preference },
    activeScope: null,
    temporarilySuppressed: false,
  };
}

/**
 * Safely resolve a Storage object, tolerating non-browser environments and
 * sandboxes where accessing `window.localStorage` throws (e.g. blocked cookies).
 */
function getStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    const storage = window.localStorage;
    if (!storage) return null;
    return storage;
  } catch {
    return null;
  }
}

/**
 * Load the persisted preference. Returns defaults when storage is unavailable,
 * empty, or holds malformed JSON / wrong-shaped values.
 */
export function loadCameraLockPreference(): CameraLockPreference {
  const storage = getStorage();
  if (!storage) return defaultCameraLockPreference();

  let raw: string | null;
  try {
    raw = storage.getItem(CAMERA_LOCK_STORAGE_KEY);
  } catch {
    return defaultCameraLockPreference();
  }
  if (raw === null) return defaultCameraLockPreference();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultCameraLockPreference();
  }
  return normalizeCameraLockPreference(parsed);
}

/**
 * Persist the preference. Silently no-ops when storage is unavailable or the
 * write fails (quota, private mode, etc.). Returns whether the write succeeded.
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

/** Input to {@link issueCameraCommand}, minus the managed `sequence`. */
export interface CameraCommandInput {
  kind: GraphCameraCommandKind;
  scope: GraphScope;
  targetId?: string | null;
  reason: string;
}

/**
 * Central command factory. This is the ONLY place the monotonic command
 * sequence is incremented — consumers must route every camera command through
 * here instead of maintaining their own `event++` / `requestId++` counters.
 */
export function createCameraCommandIssuer(initialSequence = 0): {
  issue: (input: CameraCommandInput) => GraphCameraCommand;
  peek: () => number;
} {
  let sequence = initialSequence;
  return {
    issue(input: CameraCommandInput): GraphCameraCommand {
      sequence += 1;
      return {
        kind: input.kind,
        scope: input.scope,
        targetId: input.targetId ?? null,
        reason: input.reason,
        sequence,
      };
    },
    peek(): number {
      return sequence;
    },
  };
}

/**
 * Process-wide default issuer. Convenience for the common case where a single
 * monotonic sequence across the whole UI is desired.
 */
const defaultIssuer = createCameraCommandIssuer();

/**
 * Issue a camera command using the shared default issuer. The returned
 * command's `sequence` is strictly greater than every previously issued one.
 */
export function issueCameraCommand(input: CameraCommandInput): GraphCameraCommand {
  return defaultIssuer.issue(input);
}
