/**
 * Shared keyboard handling for Invoker context menus.
 *
 * Menus own ArrowUp/ArrowDown/Enter/Space while open so app-level graph
 * shortcuts don't fight the highlighted item.
 */

export const MENU_HANDLED_KEYS = new Set<string>(['ArrowUp', 'ArrowDown', 'Enter', ' ']);

export function isMenuHandledKey(key: string): boolean {
  return MENU_HANDLED_KEYS.has(key);
}

/**
 * Cycle through enabled item indices in the given direction. Returns null if
 * no enabled items exist. If `current` is not enabled, snaps to the first or
 * last enabled item based on direction.
 */
export function nextEnabledIndex(
  current: number,
  itemCount: number,
  isEnabled: (index: number) => boolean,
  direction: 1 | -1,
): number | null {
  const enabled: number[] = [];
  for (let i = 0; i < itemCount; i += 1) {
    if (isEnabled(i)) enabled.push(i);
  }
  if (enabled.length === 0) return null;
  const pos = enabled.indexOf(current);
  if (pos < 0) {
    return direction === 1 ? enabled[0] : enabled[enabled.length - 1];
  }
  const next = (pos + direction + enabled.length) % enabled.length;
  return enabled[next];
}
