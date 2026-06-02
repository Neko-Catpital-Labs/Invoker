/**
 * menu-keyboard — Shared keyboard navigation helpers for context menus.
 *
 * Both the task ContextMenu and the workflow context menu cycle a highlight
 * through a set of enabled, focusable indices. This keeps that wrapping logic
 * in one place so disabled items are skipped consistently.
 */

/**
 * Given the list of focusable indices (already filtered to skip disabled
 * items) and the currently highlighted index, return the next index when
 * moving in `direction` (+1 = down, -1 = up). Wraps around the ends and is a
 * no-op when nothing is focusable.
 */
export function cycleIndex(navigable: number[], current: number, direction: 1 | -1): number {
  if (navigable.length === 0) return current;
  const pos = navigable.indexOf(current);
  if (pos === -1) {
    return direction === 1 ? navigable[0] : navigable[navigable.length - 1];
  }
  const next = (pos + direction + navigable.length) % navigable.length;
  return navigable[next];
}

/** Keys that an open context menu owns for navigation/activation. */
export function isMenuNavigationKey(key: string): boolean {
  return key === 'ArrowUp' || key === 'ArrowDown' || key === 'Enter' || key === ' ';
}
