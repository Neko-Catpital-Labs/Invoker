import { describe, expect, it, vi } from 'vitest';
import {
  persistRendererRecoveryState,
  readRendererRecoveryState,
  RENDERER_RECOVERY_STATE_KEY,
} from '../lib/renderer-recovery-state.js';

describe('renderer recovery state', () => {
  it('round-trips safe navigation state', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    persistRendererRecoveryState({
      sidebarSurface: 'workflows',
      viewMode: 'dag',
      selectedTaskId: 'task-beta',
      selectedWorkflowId: 'workflow-1',
      inspectorCollapsed: false,
    }, storage);

    expect(readRendererRecoveryState(storage)).toEqual({
      sidebarSurface: 'workflows',
      viewMode: 'dag',
      selectedTaskId: 'task-beta',
      selectedWorkflowId: 'workflow-1',
      inspectorCollapsed: false,
    });
    expect(values.has(RENDERER_RECOVERY_STATE_KEY)).toBe(true);
  });

  it('falls back when persisted state is malformed or storage throws', () => {
    expect(readRendererRecoveryState({ getItem: () => '{broken' })).toEqual({
      sidebarSurface: 'home',
      viewMode: 'dag',
      selectedTaskId: null,
      selectedWorkflowId: null,
      inspectorCollapsed: false,
    });

    const setItem = vi.fn(() => { throw new Error('blocked'); });
    expect(() => persistRendererRecoveryState({
      sidebarSurface: 'home',
      viewMode: 'dag',
      selectedTaskId: null,
      selectedWorkflowId: null,
      inspectorCollapsed: false,
    }, { setItem })).not.toThrow();
  });
});
