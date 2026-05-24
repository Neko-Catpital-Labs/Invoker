/**
 * Keyboard navigation helpers shared between ContextMenu (task) and
 * WorkflowContextMenu. Both menus need the same primitives: skip disabled
 * items, wrap around at the edges, and activate the focused item on
 * Enter or Space.
 */

import type { KeyboardEvent } from 'react';

export interface NavigableMenuItem {
  enabled: boolean;
}

export function findFirstEnabledIndex<T extends NavigableMenuItem>(items: T[]): number {
  return items.findIndex((item) => item.enabled);
}

export function findNextEnabledIndex<T extends NavigableMenuItem>(
  items: T[],
  from: number,
  direction: 1 | -1,
): number {
  const len = items.length;
  if (len === 0) return -1;
  for (let step = 1; step <= len; step++) {
    const idx = ((from + direction * step) % len + len) % len;
    if (items[idx].enabled) return idx;
  }
  return from;
}

/**
 * Handle a keyboard event for a menu. Returns true if the key was a menu key
 * (Arrow/Enter/Space) and was handled — in that case preventDefault and
 * stopPropagation have already been called on the event.
 */
export function dispatchMenuKey<T extends NavigableMenuItem>(
  event: KeyboardEvent,
  items: T[],
  focusedIndex: number,
  onMove: (nextIndex: number) => void,
  onActivate: (item: T, index: number) => void,
): boolean {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    event.stopPropagation();
    const next = findNextEnabledIndex(items, focusedIndex, 1);
    if (next >= 0) onMove(next);
    return true;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    event.stopPropagation();
    const next = findNextEnabledIndex(items, focusedIndex, -1);
    if (next >= 0) onMove(next);
    return true;
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    event.stopPropagation();
    const item = items[focusedIndex];
    if (item?.enabled) onActivate(item, focusedIndex);
    return true;
  }
  return false;
}
