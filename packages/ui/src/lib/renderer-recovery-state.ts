import type { SidebarSurface } from './workflow-progress-surfaces.js';

export type RendererRecoveryViewMode = 'dag' | 'history' | 'timeline' | 'queue' | 'actionGraph';

export type RendererRecoveryState = {
  sidebarSurface: SidebarSurface;
  viewMode: RendererRecoveryViewMode;
  selectedTaskId: string | null;
  selectedWorkflowId: string | null;
  inspectorCollapsed: boolean;
};

export const RENDERER_RECOVERY_STATE_KEY = 'invoker.renderer-recovery-state.v1';

const DEFAULT_RENDERER_RECOVERY_STATE: RendererRecoveryState = {
  sidebarSurface: 'home',
  viewMode: 'dag',
  selectedTaskId: null,
  selectedWorkflowId: null,
  inspectorCollapsed: false,
};

const SIDEBAR_SURFACES = new Set<SidebarSurface>(['home', 'planning', 'workflows', 'attention', 'workers']);
const VIEW_MODES = new Set<RendererRecoveryViewMode>(['dag', 'history', 'timeline', 'queue', 'actionGraph']);

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function readRendererRecoveryState(
  storage: Pick<Storage, 'getItem'> | undefined = typeof window === 'undefined' ? undefined : window.localStorage,
): RendererRecoveryState {
  if (!storage) return DEFAULT_RENDERER_RECOVERY_STATE;
  try {
    const raw = storage.getItem(RENDERER_RECOVERY_STATE_KEY);
    if (!raw) return DEFAULT_RENDERER_RECOVERY_STATE;
    const parsed = JSON.parse(raw) as Partial<RendererRecoveryState>;
    return {
      sidebarSurface: SIDEBAR_SURFACES.has(parsed.sidebarSurface as SidebarSurface)
        ? parsed.sidebarSurface as SidebarSurface
        : DEFAULT_RENDERER_RECOVERY_STATE.sidebarSurface,
      viewMode: VIEW_MODES.has(parsed.viewMode as RendererRecoveryViewMode)
        ? parsed.viewMode as RendererRecoveryViewMode
        : DEFAULT_RENDERER_RECOVERY_STATE.viewMode,
      selectedTaskId: nullableString(parsed.selectedTaskId),
      selectedWorkflowId: nullableString(parsed.selectedWorkflowId),
      inspectorCollapsed: typeof parsed.inspectorCollapsed === 'boolean'
        ? parsed.inspectorCollapsed
        : DEFAULT_RENDERER_RECOVERY_STATE.inspectorCollapsed,
    };
  } catch {
    return DEFAULT_RENDERER_RECOVERY_STATE;
  }
}

export function persistRendererRecoveryState(
  state: RendererRecoveryState,
  storage: Pick<Storage, 'setItem'> | undefined = typeof window === 'undefined' ? undefined : window.localStorage,
): void {
  if (!storage) return;
  try {
    storage.setItem(RENDERER_RECOVERY_STATE_KEY, JSON.stringify(state));
  } catch {
  }
}
