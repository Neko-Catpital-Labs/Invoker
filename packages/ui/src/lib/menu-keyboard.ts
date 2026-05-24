/**
 * Shared keyboard-navigation helpers for context menus.
 *
 * Both ContextMenu (task) and WorkflowContextMenu (workflow) build a list of
 * navigable items where some entries may be disabled. These helpers cycle the
 * highlight through the enabled subset, skipping disabled entries.
 */

export interface NavigableItem {
  readonly enabled: boolean;
}

export function firstEnabledIndex(items: ReadonlyArray<NavigableItem>): number {
  return items.findIndex((item) => item.enabled);
}

/**
 * Move the highlight by `direction` (+1 for next, -1 for previous), wrapping
 * around and skipping disabled entries. Returns -1 if nothing is enabled.
 */
export function moveEnabledIndex(
  items: ReadonlyArray<NavigableItem>,
  currentIndex: number,
  direction: 1 | -1,
): number {
  const n = items.length;
  if (n === 0) return -1;
  let idx = currentIndex;
  if (idx < 0 || idx >= n) {
    idx = direction === 1 ? -1 : n;
  }
  for (let step = 0; step < n; step++) {
    idx = (idx + direction + n) % n;
    if (items[idx].enabled) return idx;
  }
  return -1;
}

export function isMenuActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' ';
}

export function isMenuNavigationKey(key: string): boolean {
  return (
    key === 'ArrowUp' ||
    key === 'ArrowDown' ||
    key === 'Enter' ||
    key === ' '
  );
}
