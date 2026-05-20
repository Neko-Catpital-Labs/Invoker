/**
 * Shared keyboard-navigation helpers for context menus.
 *
 * ContextMenu (task) and WorkflowContextMenu both expose keyboard navigation
 * with ArrowUp/ArrowDown to move the highlight, skipping disabled entries,
 * and Enter or Space to activate. These helpers avoid duplicating the
 * cycling/wraparound math and the set of keys the App-level handler must
 * leave alone while a menu is open.
 */

export const MENU_NAV_KEYS: ReadonlySet<string> = new Set([
  'ArrowUp',
  'ArrowDown',
  'Enter',
  ' ',
]);

/**
 * Returns the next index whose corresponding `enabled` flag is true, wrapping
 * at both ends. If no entries are enabled, returns the current index. If the
 * current index is not enabled, falls back to the first/last enabled entry
 * depending on the direction.
 */
export function nextEnabledIndex(
  enabled: ReadonlyArray<boolean>,
  current: number,
  delta: 1 | -1,
): number {
  const positions: number[] = [];
  for (let i = 0; i < enabled.length; i++) {
    if (enabled[i]) positions.push(i);
  }
  if (positions.length === 0) return current;
  const pos = positions.indexOf(current);
  if (pos < 0) {
    return delta > 0 ? positions[0] : positions[positions.length - 1];
  }
  const next = (pos + delta + positions.length) % positions.length;
  return positions[next];
}

/**
 * Returns the index of the first enabled entry, or 0 when nothing is enabled.
 * Used to seed `focusedIndex` so the highlight lands on an actionable item
 * when the menu opens.
 */
export function firstEnabledIndex(enabled: ReadonlyArray<boolean>): number {
  for (let i = 0; i < enabled.length; i++) {
    if (enabled[i]) return i;
  }
  return 0;
}
