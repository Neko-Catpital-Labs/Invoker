/**
 * Keyboard navigation helpers shared by the task and workflow context menus.
 *
 * Both menus need to:
 * - Cycle ArrowUp/ArrowDown through enabled items, skipping disabled ones.
 * - Activate the focused item on Enter or Space.
 * - Receive focus on open (and after expanding "More").
 */

export interface KeyboardMenuItem {
  enabled: boolean;
}

/**
 * Find the next enabled item index, cycling in the given direction.
 * Returns the current index if no other enabled item exists, or -1 if empty.
 */
export function findNextEnabledIndex(
  items: KeyboardMenuItem[],
  current: number,
  direction: 1 | -1,
): number {
  const n = items.length;
  if (n === 0) return -1;
  for (let step = 1; step <= n; step += 1) {
    const next = ((current + direction * step) % n + n) % n;
    if (items[next]?.enabled) return next;
  }
  return current;
}

/** First enabled index, or 0 if none are enabled. */
export function findFirstEnabledIndex(items: KeyboardMenuItem[]): number {
  const idx = items.findIndex((item) => item.enabled);
  return idx >= 0 ? idx : 0;
}

/** Keys this module owns; callers can match against this set to know to defer. */
export const MENU_OWNED_KEYS: ReadonlySet<string> = new Set([
  'ArrowUp',
  'ArrowDown',
  'Enter',
  ' ',
  'Escape',
]);
