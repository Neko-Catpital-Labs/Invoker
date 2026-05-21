/**
 * Shared keyboard navigation for context menus.
 *
 * ArrowDown/ArrowUp move focus through enabled entries, wrapping at the ends
 * and skipping disabled items. Enter/Space activate the focused entry.
 * Handled keys always call preventDefault and stopPropagation so the host
 * application does not also act on them.
 */

import type { KeyboardEvent } from 'react';

export interface MenuEntry {
  enabled: boolean;
  onActivate: () => void;
}

/**
 * Find the next enabled entry starting at `from` and stepping by `direction`,
 * wrapping at the array boundary. Returns -1 when no entry is enabled.
 */
export function findEnabledIndex(
  entries: ReadonlyArray<MenuEntry>,
  from: number,
  direction: 1 | -1,
): number {
  const n = entries.length;
  if (n === 0) return -1;
  for (let step = 0; step < n; step++) {
    const idx = (((from + direction * step) % n) + n) % n;
    if (entries[idx]?.enabled) return idx;
  }
  return -1;
}

/**
 * Apply keyboard navigation to a menu of `entries`. Returns true when the
 * event was handled (and preventDefault/stopPropagation were called).
 */
export function handleMenuKeyDown(
  event: KeyboardEvent,
  entries: ReadonlyArray<MenuEntry>,
  focusedIndex: number,
  setFocusedIndex: (index: number) => void,
): boolean {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    event.stopPropagation();
    const direction: 1 | -1 = event.key === 'ArrowDown' ? 1 : -1;
    const next = findEnabledIndex(entries, focusedIndex + direction, direction);
    if (next >= 0) setFocusedIndex(next);
    return true;
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    event.stopPropagation();
    const entry = entries[focusedIndex];
    if (entry?.enabled) entry.onActivate();
    return true;
  }
  return false;
}
