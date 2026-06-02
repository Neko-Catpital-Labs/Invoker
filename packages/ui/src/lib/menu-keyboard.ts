/**
 * Shared keyboard-navigation helpers for context menus.
 *
 * Both the task ContextMenu and the WorkflowContextMenu navigate a flat list of
 * rows where some rows may be disabled. These helpers centralise the "which row
 * does ArrowUp/ArrowDown land on" logic so the two menus stay in sync.
 */

/** A navigable menu row. Only `enabled` matters for navigation. */
export interface MenuNavRow {
  enabled: boolean;
}

/** Indices (into `rows`) of rows that can receive focus / be activated. */
export function getEnabledIndices(rows: MenuNavRow[]): number[] {
  const indices: number[] = [];
  rows.forEach((row, idx) => {
    if (row.enabled) indices.push(idx);
  });
  return indices;
}

/**
 * Return the next enabled index when moving in `direction` (1 = down, -1 = up),
 * cycling around the ends and skipping disabled rows. Falls back to the first /
 * last enabled row when `current` is not itself enabled.
 */
export function cycleEnabledIndex(
  enabledIndices: number[],
  current: number,
  direction: 1 | -1
): number {
  if (enabledIndices.length === 0) return current;
  const pos = enabledIndices.indexOf(current);
  if (pos === -1) {
    return direction === 1 ? enabledIndices[0] : enabledIndices[enabledIndices.length - 1];
  }
  const nextPos = (pos + direction + enabledIndices.length) % enabledIndices.length;
  return enabledIndices[nextPos];
}

/** Keys a context menu owns and should not let bubble to global shortcuts. */
export const MENU_NAV_KEYS = ['ArrowUp', 'ArrowDown', 'Enter', ' '] as const;

/** Whether `key` is a navigation/activation key owned by an open menu. */
export function isMenuNavKey(key: string): boolean {
  return (MENU_NAV_KEYS as readonly string[]).includes(key);
}
