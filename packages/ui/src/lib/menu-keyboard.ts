/**
 * Shared keyboard navigation helpers for floating menus.
 *
 * Both task and workflow context menus need ArrowUp/ArrowDown cycling that
 * skips disabled items. Keeping the math in one place avoids drift.
 */

export interface NavigableItem {
  enabled: boolean;
}

export function firstEnabledIndex(items: ReadonlyArray<NavigableItem>): number {
  return items.findIndex((item) => item.enabled);
}

export function nextEnabledIndex(
  items: ReadonlyArray<NavigableItem>,
  current: number,
  direction: 1 | -1,
): number {
  const total = items.length;
  if (total === 0) return -1;
  for (let step = 1; step <= total; step++) {
    const candidate = ((current + direction * step) % total + total) % total;
    if (items[candidate]?.enabled) return candidate;
  }
  return current;
}

export const MENU_KEYS = new Set(['ArrowUp', 'ArrowDown', 'Enter', ' ']);
