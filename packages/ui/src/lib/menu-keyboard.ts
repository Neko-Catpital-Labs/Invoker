/**
 * Shared keyboard-navigation helper for menu surfaces.
 *
 * Both the task and workflow context menus need to cycle the highlight
 * through enabled entries while skipping disabled ones. Keeping the cycle
 * here removes the duplicated index math each menu would otherwise carry.
 */

export interface NavigableEntry {
  enabled: boolean;
}

/**
 * Return the next enabled index in `items`, cycling. If no items are enabled,
 * the current index is returned unchanged.
 */
export function nextEnabledIndex(
  items: ReadonlyArray<NavigableEntry>,
  currentIndex: number,
  direction: 1 | -1,
): number {
  const enabled: number[] = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].enabled) enabled.push(i);
  }
  if (enabled.length === 0) return currentIndex;
  const currentPos = enabled.indexOf(currentIndex);
  if (currentPos === -1) {
    return direction === 1 ? enabled[0] : enabled[enabled.length - 1];
  }
  const nextPos = (currentPos + direction + enabled.length) % enabled.length;
  return enabled[nextPos];
}

/** Index of the first enabled entry, or -1 if none. */
export function firstEnabledIndex(items: ReadonlyArray<NavigableEntry>): number {
  for (let i = 0; i < items.length; i++) {
    if (items[i].enabled) return i;
  }
  return -1;
}
