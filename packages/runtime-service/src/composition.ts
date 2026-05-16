/**
 * Runtime composition shell — a typed container that bundles runtime
 * domain ports into a single `RuntimeServices` facade.
 *
 * Consumers call `composeRuntimeServices(deps)` with concrete adapter
 * implementations; this module never instantiates adapters itself, so
 * app wiring stays in the application layer.
 */

import type {
  WorkspaceProbe,
  ContainerProbe,
  SessionProbe,
  TerminalLauncher,
} from '@invoker/runtime-domain';

// ── Dormant bridge hook ──────────────────────────────────────

/**
 * Callback invoked when the dormant runtime bridge is enabled.
 * Receives the composed services for external wiring (e.g. IPC,
 * message bus, or cross-process relay). The hook is a no-op slot:
 * the bridge is dormant unless the caller explicitly opts in.
 */
export type DormantBridgeHook = (services: RuntimeServices) => void;

// ── Dependency slot ────────────────────────────────────────

/** Ports that callers must supply to compose the runtime services. */
export interface RuntimeServiceDeps {
  workspaceProbe: WorkspaceProbe;
  containerProbe: ContainerProbe;
  sessionProbe: SessionProbe;
  terminalLauncher: TerminalLauncher;

  /**
   * When `true`, the dormant bridge hook fires after composition.
   * Defaults to `false` — active behavior is unchanged.
   */
  enableDormantBridge?: boolean;

  /**
   * Optional callback invoked only when `enableDormantBridge` is `true`.
   * Ignored otherwise.
   */
  dormantBridgeHook?: DormantBridgeHook;
}

// ── Public facade ──────────────────────────────────────────

/** Unified read-only view of the composed runtime services. */
export interface RuntimeServices {
  readonly workspaceProbe: WorkspaceProbe;
  readonly containerProbe: ContainerProbe;
  readonly sessionProbe: SessionProbe;
  readonly terminalLauncher: TerminalLauncher;
}

export const RUNTIME_SERVICE_KEYS = Object.freeze([
  'workspaceProbe',
  'containerProbe',
  'sessionProbe',
  'terminalLauncher',
] as const satisfies readonly (keyof RuntimeServices)[]);

function assertRuntimeServiceFacadeShape(services: RuntimeServices): void {
  const actual = Object.keys(services).sort();
  const expected = [...RUNTIME_SERVICE_KEYS].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`RuntimeServices facade keys mismatch: ${actual.join(', ')}`);
  }
}

// ── Factory ────────────────────────────────────────────────

/**
 * Compose runtime services from concrete port implementations.
 *
 * Returns a frozen `RuntimeServices` object. No adapter instantiation
 * happens here — callers provide fully constructed adapters.
 */
export function composeRuntimeServices(
  deps: RuntimeServiceDeps,
): RuntimeServices {
  const services = Object.freeze({
    workspaceProbe: deps.workspaceProbe,
    containerProbe: deps.containerProbe,
    sessionProbe: deps.sessionProbe,
    terminalLauncher: deps.terminalLauncher,
  } satisfies RuntimeServices);
  assertRuntimeServiceFacadeShape(services);

  if (deps.enableDormantBridge === true && deps.dormantBridgeHook) {
    deps.dormantBridgeHook(services);
  }

  return services;
}

// ── Headless startup composition ──────────────────────────

/**
 * Compose runtime services for the headless startup path.
 *
 * Delegates to `composeRuntimeServices` with the same port contracts,
 * making the headless entry point an explicit routing target rather
 * than an implicit consumer of a module-level variable.
 *
 * Owner/delegation behavior is unaffected — this function only
 * composes the runtime-domain ports; orchestration and task dispatch
 * remain the caller's responsibility.
 */
export function composeHeadlessStartup(
  deps: RuntimeServiceDeps,
): RuntimeServices {
  return composeRuntimeServices(deps);
}
