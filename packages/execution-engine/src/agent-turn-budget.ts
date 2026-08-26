/**
 * Harness-agnostic turn budget for agents without a native CLI turn flag.
 * Counts assistant/tool turns from streaming JSONL and signals when the cap is hit.
 */

export type TurnBudgetEvent =
  | { kind: 'turn' }
  | { kind: 'ignored' };

/** True when a JSONL row represents one countable agent turn. */
export function countTurnFromJsonlLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  let row: Record<string, unknown>;
  try {
    row = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return false;
  }

  const type = typeof row.type === 'string' ? row.type : '';
  // Codex / similar structured streams
  if (type === 'turn.completed' || type === 'turn.failed') return true;
  if (type === 'agent_message' || type === 'message') {
    const role = (row.role ?? (row.payload as { role?: string } | undefined)?.role);
    if (role === 'assistant') return true;
  }
  // Claude-shaped (if ever streamed)
  if (type === 'assistant') return true;
  const msg = row.message as { role?: string } | undefined;
  if (msg?.role === 'assistant') return true;
  // OMP / generic response_item
  const payload = row.payload as { type?: string; role?: string } | undefined;
  if (row.type === 'response_item' && payload?.type === 'message' && payload.role === 'assistant') {
    return true;
  }
  return false;
}

export interface TurnBudgetWatcher {
  /** Feed a raw stdout/stderr chunk; returns true when budget is exhausted. */
  push(chunk: string): boolean;
  readonly turns: number;
  readonly maxTurns: number;
  readonly exhausted: boolean;
}

export function createTurnBudgetWatcher(maxTurns: number): TurnBudgetWatcher {
  let turns = 0;
  let exhausted = false;
  let buffer = '';

  return {
    get turns() {
      return turns;
    },
    get maxTurns() {
      return maxTurns;
    },
    get exhausted() {
      return exhausted;
    },
    push(chunk: string): boolean {
      if (exhausted || maxTurns <= 0) return exhausted;
      buffer += chunk;
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() ?? '';
      for (const line of parts) {
        if (!countTurnFromJsonlLine(line)) continue;
        turns += 1;
        if (turns >= maxTurns) {
          exhausted = true;
          return true;
        }
      }
      return false;
    },
  };
}

/** Agents that already pass --max-turns (or equivalent) in argv. */
export function agentUsesNativeMaxTurns(agentName: string): boolean {
  return agentName === 'claude';
}
