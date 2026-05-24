/**
 * Keyboard navigation helpers shared by context menus.
 *
 * Cycles a focus index through enabled items, skipping disabled entries.
 */

export interface KeyboardNavItem {
  enabled: boolean;
}

export function firstEnabledIndex(items: ReadonlyArray<KeyboardNavItem>): number {
  return items.findIndex((item) => item.enabled);
}

export function nextEnabledIndex(
  items: ReadonlyArray<KeyboardNavItem>,
  currentIndex: number,
  direction: 1 | -1,
): number {
  const enabled: number[] = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].enabled) enabled.push(i);
  }
  if (enabled.length === 0) return currentIndex;
  const pos = enabled.indexOf(currentIndex);
  if (pos < 0) {
    return direction === 1 ? enabled[0] : enabled[enabled.length - 1];
  }
  return enabled[(pos + direction + enabled.length) % enabled.length];
}
