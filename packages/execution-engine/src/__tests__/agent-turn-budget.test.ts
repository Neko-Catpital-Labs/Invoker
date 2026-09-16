import { describe, it, expect } from 'vitest';
import {
  agentUsesNativeMaxTurns,
  countTurnFromJsonlLine,
  createTurnBudgetWatcher,
} from '../agent-turn-budget.js';

describe('agent-turn-budget', () => {
  it('counts Codex turn.completed lines', () => {
    expect(countTurnFromJsonlLine(JSON.stringify({ type: 'turn.completed' }))).toBe(true);
    expect(countTurnFromJsonlLine(JSON.stringify({ type: 'thread.started' }))).toBe(false);
  });

  it('exhausts after maxTurns', () => {
    const watcher = createTurnBudgetWatcher(3);
    expect(watcher.push(`${JSON.stringify({ type: 'turn.completed' })}\n`)).toBe(false);
    expect(watcher.push(`${JSON.stringify({ type: 'turn.completed' })}\n`)).toBe(false);
    expect(watcher.push(`${JSON.stringify({ type: 'turn.completed' })}\n`)).toBe(true);
    expect(watcher.exhausted).toBe(true);
    expect(watcher.turns).toBe(3);
  });

  it('marks only claude as native maxTurns', () => {
    expect(agentUsesNativeMaxTurns('claude')).toBe(true);
    expect(agentUsesNativeMaxTurns('codex')).toBe(false);
    expect(agentUsesNativeMaxTurns('omp')).toBe(false);
  });
});
