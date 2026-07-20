/**
 * Emit a ui_navigation mark so renderer_event_loop_lag can be correlated
 * with sidebar / view transitions. Telemetry only.
 */

export type UiNavigationKind = 'sidebarSurface' | 'viewMode';

export function reportUiNavigation(
  reportUiPerf: ((metric: string, data?: Record<string, unknown>) => unknown) | undefined,
  data: {
    kind: UiNavigationKind;
    from: string;
    to: string;
    sidebarSurface?: string;
    viewMode?: string;
    dismiss?: boolean;
  },
): void {
  if (!reportUiPerf) return;
  void reportUiPerf('ui_navigation', data);
}
