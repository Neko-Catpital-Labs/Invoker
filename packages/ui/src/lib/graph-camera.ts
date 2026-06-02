/**
 * Camera preference + graph navigation command model for the UI.
 *
 * Why this module exists:
 *   The workflow graph and the selected workflow's task DAG share a small
 *   vocabulary — what is selected, which graph is "active", whether the
 *   camera should auto-recenter, whether the user has manually suppressed
 *   recentering, and one-shot viewport commands like "center on selection"
 *   or "fit initial view". Without a shared model, App selection handlers
 *   reach for ad hoc patterns like `event++` / `requestId++` to force React
 *   Flow viewport effects to re-run, which scatters identity state across
 *   components and is easy to get wrong.
 *
 *   This module is the single source of monotonic sequence numbers for
 *   GraphCameraCommand. Consumers must obtain commands through
 *   `createGraphCameraIssuer()`; no other call site should mint sequence
 *   numbers directly.
 *
 * React Flow ownership note:
 *   React Flow keeps owning its internal x/y/zoom locally so manual pan and
 *   zoom remain responsive. Commands here describe *intent* ("center this
 *   node", "fit the initial view"), not a fully controlled viewport.
 */

/** Which graph the camera intent applies to. */
export type GraphScope = 'workflow' | 'task';

/**
 * How the user wants the camera lock to behave when selection changes:
 *   - `toggle`: camera follows selection until the user pans/zooms manually,
 *               then stays put until the next explicit recenter.
 *   - `once`:   camera recenters on the next selection change only, then
 *               releases.
 */
export type CameraMode = 'toggle' | 'once';

/** The two viewport intents this model expresses. */
export type GraphCameraCommandStyle = 'centerSelection' | 'fitInitial';

/** Persisted preference describing how the camera lock should behave. */
export interface CameraLockPreference {
  mode: CameraMode;
  enabled: boolean;
}

/**
 * A single viewport command. Consumers compare `sequence` (and not deep
 * equality of the rest of the object) to decide whether to re-apply.
 *
 * `target` is the workflow or task id the command refers to, or `null` for
 * commands like `fitInitial` that have no specific target.
 */
export interface GraphCameraCommand {
  style: GraphCameraCommandStyle;
  scope: GraphScope;
  target: string | null;
  reason: string;
  sequence: number;
}

/** Default user preference: lock is on, follows selection until user pans. */
export const DEFAULT_CAMERA_LOCK_PREFERENCE: CameraLockPreference = Object.freeze({
  mode: 'toggle',
  enabled: true,
}) as CameraLockPreference;

/** localStorage key for the persisted preference. Exported for tests. */
export const CAMERA_LOCK_PREFERENCE_STORAGE_KEY = 'invoker.ui.graphCamera.lockPreference.v1';

const VALID_MODES: ReadonlySet<CameraMode> = new Set<CameraMode>(['toggle', 'once']);

function isCameraLockPreference(value: unknown): value is CameraLockPreference {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.enabled !== 'boolean') return false;
  if (typeof candidate.mode !== 'string') return false;
  if (!VALID_MODES.has(candidate.mode as CameraMode)) return false;
  return true;
}

function resolveStorage(storage?: Storage | null): Storage | null {
  if (storage) return storage;
  if (storage === null) return null;
  try {
    if (typeof globalThis !== 'undefined' && (globalThis as { localStorage?: Storage }).localStorage) {
      return (globalThis as { localStorage: Storage }).localStorage;
    }
  } catch {
    // Access to localStorage can throw in sandboxed contexts; fall through.
  }
  return null;
}

/**
 * Read the persisted camera lock preference. Any failure — missing storage,
 * non-JSON value, missing fields, wrong types, unknown mode — yields the
 * default preference rather than throwing. Callers can rely on receiving a
 * valid object.
 */
export function loadCameraLockPreference(storage?: Storage | null): CameraLockPreference {
  const target = resolveStorage(storage);
  if (!target) return { ...DEFAULT_CAMERA_LOCK_PREFERENCE };
  let raw: string | null = null;
  try {
    raw = target.getItem(CAMERA_LOCK_PREFERENCE_STORAGE_KEY);
  } catch {
    return { ...DEFAULT_CAMERA_LOCK_PREFERENCE };
  }
  if (raw === null) return { ...DEFAULT_CAMERA_LOCK_PREFERENCE };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_CAMERA_LOCK_PREFERENCE };
  }
  if (!isCameraLockPreference(parsed)) return { ...DEFAULT_CAMERA_LOCK_PREFERENCE };
  return { mode: parsed.mode, enabled: parsed.enabled };
}

/**
 * Persist the camera lock preference. Silently no-ops if storage is
 * unavailable or write throws (e.g. quota or private-mode restrictions).
 */
export function saveCameraLockPreference(
  preference: CameraLockPreference,
  storage?: Storage | null,
): void {
  const target = resolveStorage(storage);
  if (!target) return;
  try {
    target.setItem(
      CAMERA_LOCK_PREFERENCE_STORAGE_KEY,
      JSON.stringify({ mode: preference.mode, enabled: preference.enabled }),
    );
  } catch {
    // Storage may be unavailable or quota-exceeded; preference is best-effort.
  }
}

/** Inputs accepted by `GraphCameraIssuer.issue`. */
export interface GraphCameraCommandInput {
  style: GraphCameraCommandStyle;
  scope: GraphScope;
  target?: string | null;
  reason: string;
}

/**
 * The sole minter of `GraphCameraCommand.sequence`. Use
 * `createGraphCameraIssuer()` per host (typically one per `App`) and route
 * every camera intent through `issue(...)`. Doing so guarantees a single
 * monotonic stream of sequence numbers across both graph scopes.
 */
export interface GraphCameraIssuer {
  issue(input: GraphCameraCommandInput): GraphCameraCommand;
  /** Current sequence number; useful for tests and snapshot comparison. */
  current(): number;
}

/** Create a fresh issuer with an internal sequence starting at 0. */
export function createGraphCameraIssuer(): GraphCameraIssuer {
  let sequence = 0;
  return {
    issue(input: GraphCameraCommandInput): GraphCameraCommand {
      sequence += 1;
      return {
        style: input.style,
        scope: input.scope,
        target: input.target ?? null,
        reason: input.reason,
        sequence,
      };
    },
    current(): number {
      return sequence;
    },
  };
}
