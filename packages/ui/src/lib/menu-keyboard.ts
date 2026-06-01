/**
 * menu-keyboard — Shared keyboard-navigation helpers for context menus.
 *
 * Both the task ContextMenu and the WorkflowContextMenu model their rows as a
 * flat list of navigable entries (each with an `enabled` flag). These helpers
 * implement the common "cycle through enabled rows, skipping disabled ones"
 * behavior and the set of keys a menu owns so the logic stays in one place.
 */

export interface NavRow {
  enabled: boolean;
}

/** Keys an open menu fully owns (preventDefault + stopPropagation). */
export const MENU_NAV_KEYS: ReadonlySet<string> = new Set([
  'ArrowUp',
  'ArrowDown',
  'Enter',
  ' ',
]);

/** True when a key should be handled by an open menu rather than the app. */
export function isMenuNavKey(key: string): boolean {
  return MENU_NAV_KEYS.has(key);
}

/** Index of the first enabled row, or -1 when none are enabled. */
export function firstEnabledIndex(rows: readonly NavRow[]): number {
  return rows.findIndex((row) => row.enabled);
}

/**
 * Next enabled index when moving in `direction` (1 = down, -1 = up), cycling
 * around the ends and skipping disabled rows. Returns `currentIndex` unchanged
 * when nothing is enabled.
 */
export function moveFocus(
  rows: readonly NavRow[],
  currentIndex: number,
  direction: 1 | -1,
): number {
  const enabled = rows.map((row, idx) => (row.enabled ? idx : -1)).filter((idx) => idx >= 0);
  if (enabled.length === 0) return currentIndex;
  const pos = enabled.indexOf(currentIndex);
  if (pos === -1) {
    return direction === 1 ? enabled[0] : enabled[enabled.length - 1];
  }
  const nextPos = (pos + direction + enabled.length) % enabled.length;
  return enabled[nextPos];
}
