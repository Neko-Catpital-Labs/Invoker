/**
 * Shared keyboard-navigation helpers for context menus.
 *
 * Both the task ContextMenu and the workflow context menu use a roving
 * highlight (tracked in component state) rather than moving DOM focus between
 * items. These helpers centralise the "cycle to the next/previous enabled
 * item" math and the set of keys a menu owns, so the two menus stay in sync.
 */

/** Keys an open context menu fully owns (prevents App-level graph shortcuts). */
export const MENU_NAVIGATION_KEYS = ['ArrowUp', 'ArrowDown', 'Enter', ' '] as const;

/** True when `key` should be handled by an open menu rather than the App. */
export function isMenuNavigationKey(key: string): boolean {
  return (MENU_NAVIGATION_KEYS as readonly string[]).includes(key);
}

/**
 * Given the indices of enabled/navigable rows and the currently highlighted
 * index, return the next index in `direction` (+1 down, -1 up), wrapping
 * around and skipping disabled rows. If `current` is not currently enabled,
 * lands on the first (down) or last (up) enabled row.
 */
export function cycleEnabledIndex(
  enabledIndices: number[],
  current: number,
  direction: 1 | -1,
): number {
  if (enabledIndices.length === 0) return current;
  const pos = enabledIndices.indexOf(current);
  if (pos === -1) {
    return direction === 1 ? enabledIndices[0] : enabledIndices[enabledIndices.length - 1];
  }
  const nextPos = (pos + direction + enabledIndices.length) % enabledIndices.length;
  return enabledIndices[nextPos];
}
