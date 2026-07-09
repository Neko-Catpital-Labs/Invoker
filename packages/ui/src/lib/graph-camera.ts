/**
 * Shared vocabulary for graph camera behaviour across the workflow graph and
 * the selected-workflow task DAG.
 *
 * This module is the single source of truth for:
 *  - which graph a camera command targets (`GraphScope`),
 *  - whether the camera re-centres on every selection or only once
 *    (`CameraMode`),
 *  - the persisted camera-lock preference (`CameraLockPreference`),
 *  - one-shot viewport commands (`GraphCameraCommand`), and
 *  - the monotonic command sequence.
 *
 * Crucially, the monotonic `sequence` only ever increments inside the issuer
 * returned by {@link createGraphCameraCommandIssuer}. No App-level selection
 * handler should keep its own `event++` / `requestId++` counter — they consume
 * commands from an issuer instead. React Flow keeps owning x/y/zoom locally;
 * these commands are intent ("centre this selection"), not a controlled
 * viewport.
 */

/** Which graph a camera command applies to. */
export type GraphScope = 'workflow' | 'task';

/**
 * How aggressively the camera follows selection.
 *  - `toggle`: re-centre whenever the selection changes (lock stays on).
 *  - `once`: centre a single time, then release until re-armed.
 */
export type CameraMode = 'toggle' | 'once';

/** Persisted camera-lock preference. */
export interface CameraLockPreference {
  /** Follow-selection behaviour. */
  mode: CameraMode;
  /** Whether the camera lock is engaged at all. */
  enabled: boolean;
}

/** The kinds of one-shot viewport commands the UI can issue. */
export type GraphCameraCommandKind = 'centerSelection' | 'fitInitial';

/**
 * A one-shot viewport command. Consumers act on a command when its `sequence`
 * is greater than the last one they handled, then record the new sequence.
 */
export interface GraphCameraCommand {
  /** What the viewport should do. */
  kind: GraphCameraCommandKind;
  /** Which graph the command targets. */
  scope: GraphScope;
  /** The node id to centre on, or `null` for whole-graph commands. */
  target: string | null;
  /** Human-readable cause, useful for debugging suppressed/forced moves. */
  reason: string;
  /** Monotonically increasing per issuer; the only mutable camera counter. */
  sequence: number;
}

/** Valid {@link CameraMode} values. */
const CAMERA_MODES: ReadonlySet<CameraMode> = new Set<CameraMode>(['toggle', 'once']);

/** Valid {@link GraphScope} values. */
const GRAPH_SCOPES: ReadonlySet<GraphScope> = new Set<GraphScope>(['workflow', 'task']);

/** localStorage key for the persisted camera-lock preference. */
export const CAMERA_LOCK_PREFERENCE_STORAGE_KEY = 'invoker.ui.cameraLockPreference';

/**
 * Default preference: follow selection on every change, lock engaged.
 * Frozen so callers cannot mutate the shared default in place.
 */
export const DEFAULT_CAMERA_LOCK_PREFERENCE: CameraLockPreference = Object.freeze({
  mode: 'toggle',
  enabled: true,
});

/** Narrow an arbitrary value to a {@link CameraMode}. */
export function isCameraMode(value: unknown): value is CameraMode {
  return typeof value === 'string' && CAMERA_MODES.has(value as CameraMode);
}

/** Narrow an arbitrary value to a {@link GraphScope}. */
export function isGraphScope(value: unknown): value is GraphScope {
  return typeof value === 'string' && GRAPH_SCOPES.has(value as GraphScope);
}

/**
 * Validate a parsed value as a {@link CameraLockPreference}. Returns a fresh,
 * fully-typed preference, or `null` if the shape is malformed.
 */
function parseCameraLockPreference(value: unknown): CameraLockPreference | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (!isCameraMode(candidate.mode)) return null;
  if (typeof candidate.enabled !== 'boolean') return null;
  return { mode: candidate.mode, enabled: candidate.enabled };
}

/**
 * Minimal storage surface so this module works against `window.localStorage`,
 * a test double, or `undefined` (e.g. SSR / disabled storage).
 */
export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Resolve the storage to use. Falls back to `globalThis.localStorage` when
 * available, otherwise `undefined` so callers degrade to defaults safely.
 */
function resolveStorage(storage?: PreferenceStorage): PreferenceStorage | undefined {
  if (storage) return storage;
  const globalStorage = (globalThis as { localStorage?: PreferenceStorage }).localStorage;
  return globalStorage ?? undefined;
}

/**
 * Load the persisted camera-lock preference, falling back to
 * {@link DEFAULT_CAMERA_LOCK_PREFERENCE} for missing, unparseable, or malformed
 * values. Never throws.
 */
export function loadCameraLockPreference(storage?: PreferenceStorage): CameraLockPreference {
  const store = resolveStorage(storage);
  if (!store) return { ...DEFAULT_CAMERA_LOCK_PREFERENCE };

  let raw: string | null;
  try {
    raw = store.getItem(CAMERA_LOCK_PREFERENCE_STORAGE_KEY);
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

  return parseCameraLockPreference(parsed) ?? { ...DEFAULT_CAMERA_LOCK_PREFERENCE };
}

/**
 * Persist the camera-lock preference. Swallows storage errors (quota, disabled
 * storage) so a failed save never breaks the UI. Returns whether the write
 * succeeded.
 */
export function saveCameraLockPreference(
  preference: CameraLockPreference,
  storage?: PreferenceStorage,
): boolean {
  const store = resolveStorage(storage);
  if (!store) return false;
  try {
    store.setItem(CAMERA_LOCK_PREFERENCE_STORAGE_KEY, JSON.stringify(preference));
    return true;
  } catch {
    return false;
  }
}

/** Fields required to issue a command; `sequence` is supplied by the issuer. */
export interface GraphCameraCommandInput {
  kind: GraphCameraCommandKind;
  scope: GraphScope;
  /** Defaults to `null` for whole-graph commands. */
  target?: string | null;
  reason: string;
}

/**
 * The only object permitted to mint {@link GraphCameraCommand}s. It owns the
 * monotonic `sequence`, so no selection handler needs an ad hoc counter.
 */
export interface GraphCameraCommandIssuer {
  /** Issue an arbitrary command, incrementing the sequence. */
  issue(input: GraphCameraCommandInput): GraphCameraCommand;
  /** Convenience: centre the given target within a scope. */
  centerSelection(scope: GraphScope, target: string, reason?: string): GraphCameraCommand;
  /** Convenience: fit the whole graph for an initial view. */
  fitInitial(scope: GraphScope, reason?: string): GraphCameraCommand;
  /** The sequence of the most recently issued command (0 before any). */
  current(): number;
}

/**
 * Create a command issuer. Each issuer owns an independent monotonic sequence
 * starting at 0; the first issued command has `sequence` 1.
 */
export function createGraphCameraCommandIssuer(): GraphCameraCommandIssuer {
  let sequence = 0;

  function issue(input: GraphCameraCommandInput): GraphCameraCommand {
    sequence += 1;
    return {
      kind: input.kind,
      scope: input.scope,
      target: input.target ?? null,
      reason: input.reason,
      sequence,
    };
  }

  return {
    issue,
    centerSelection(scope, target, reason = 'centerSelection') {
      return issue({ kind: 'centerSelection', scope, target, reason });
    },
    fitInitial(scope, reason = 'fitInitial') {
      return issue({ kind: 'fitInitial', scope, target: null, reason });
    },
    current() {
      return sequence;
    },
  };
}
