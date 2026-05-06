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

// ── Dependency slot ────────────────────────────────────────

/** Ports that callers must supply to compose the runtime services. */
export interface RuntimeServiceDeps {
  workspaceProbe: WorkspaceProbe;
  containerProbe: ContainerProbe;
  sessionProbe: SessionProbe;
  terminalLauncher: TerminalLauncher;
}

// ── Public facade ──────────────────────────────────────────

/** Unified read-only view of the composed runtime services. */
export interface RuntimeServices {
  readonly workspaceProbe: WorkspaceProbe;
  readonly containerProbe: ContainerProbe;
  readonly sessionProbe: SessionProbe;
  readonly terminalLauncher: TerminalLauncher;
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
  return Object.freeze({
    workspaceProbe: deps.workspaceProbe,
    containerProbe: deps.containerProbe,
    sessionProbe: deps.sessionProbe,
    terminalLauncher: deps.terminalLauncher,
  });
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
