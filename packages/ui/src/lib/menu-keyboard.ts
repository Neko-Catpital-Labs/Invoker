/**
 * Shared keyboard cycling for context menus.
 *
 * Both ContextMenu and WorkflowContextMenu use ArrowUp/ArrowDown to walk a
 * vertical list of items, skipping disabled entries and wrapping at the ends.
 */

export interface NavigableItem {
  enabled: boolean;
}

/**
 * Return the next enabled index in `items` relative to `current`, moving in
 * `direction` (1 = ArrowDown, -1 = ArrowUp) and wrapping around. Returns
 * `current` when no enabled item exists.
 */
export function findNextEnabledIndex<T extends NavigableItem>(
  items: T[],
  current: number,
  direction: 1 | -1,
): number {
  if (items.length === 0) return current;
  const enabled: number[] = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].enabled) enabled.push(i);
  }
  if (enabled.length === 0) return current;
  const pos = enabled.indexOf(current);
  if (pos === -1) {
    return direction === 1 ? enabled[0] : enabled[enabled.length - 1];
  }
  const nextPos = (pos + direction + enabled.length) % enabled.length;
  return enabled[nextPos];
}

/**
 * Return the first enabled index in `items`, or -1 when none are enabled.
 */
export function findFirstEnabledIndex<T extends NavigableItem>(items: T[]): number {
  for (let i = 0; i < items.length; i++) {
    if (items[i].enabled) return i;
  }
  return -1;
}
