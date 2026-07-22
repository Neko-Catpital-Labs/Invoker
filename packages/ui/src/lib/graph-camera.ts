/**
 * Shared vocabulary for graph camera behaviour across the workflow graph and
 * the selected-workflow task DAG.
 *
 * This module is the single source of truth for:
 *  - which graph a camera command targets (`GraphScope`),
 *  - one-shot viewport commands (`GraphCameraCommand`), and
 *  - the monotonic command sequence.
 *
 * Crucially, the monotonic `sequence` only ever increments inside the issuer
 * returned by {@link createGraphCameraCommandIssuer}. No App-level selection
 * handler should keep its own `event++` / `requestId++` counter. Selection
 * alone is not a camera command: React Flow keeps owning x/y/zoom locally, and
 * the App issues commands only for explicit navigation/framing intents.
 */

/** Which graph a camera command applies to. */
export type GraphScope = 'workflow' | 'task';

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

/** React Flow viewport coordinates captured for restoring a graph remount. */
export interface GraphCameraViewport {
  x: number;
  y: number;
  zoom: number;
}

/** Valid {@link GraphScope} values. */
const GRAPH_SCOPES: ReadonlySet<GraphScope> = new Set<GraphScope>(['workflow', 'task']);

/** Narrow an arbitrary value to a {@link GraphScope}. */
export function isGraphScope(value: unknown): value is GraphScope {
  return typeof value === 'string' && GRAPH_SCOPES.has(value as GraphScope);
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
